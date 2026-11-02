"""Weather snapshot and rules used by the renderer."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from threading import Event, Lock, Thread
import time
from typing import Any, Callable, Mapping
from urllib.request import urlopen

from .palette import DEFAULT_PALETTE, PaletteStore, gradient_for

CATEGORIES = ("clear", "cloudy", "rain")
OVERRIDE_SECONDS = 600
VISIT_PREFETCH_MINUTE = 58  # Fetch the next visit location at hh:58 so the hour switch uses fresh data.
RAIN_CODES = {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99}


def category_for(code: int) -> str:
    if code in (0, 1):
        return "clear"
    if code in (2, 3, 45, 48):
        return "cloudy"
    if code in RAIN_CODES:
        return "rain"
    raise ValueError(f"unknown weather code: {code}")


def fetch_current(latitude: float, longitude: float) -> dict[str, Any]:
    from urllib.parse import urlencode

    query = urlencode({
        "latitude": latitude, "longitude": longitude,
        "current": "temperature_2m,weather_code",
        "timezone": "auto",
    })
    with urlopen(f"https://api.open-meteo.com/v1/forecast?{query}", timeout=8) as response:
        return json.load(response)["current"]


class WeatherStore:
    def __init__(self, config: Mapping[str, Any], unit_count: int,
                 fetch: Callable[[float, float], Mapping[str, Any]] = fetch_current,
                 clock: Callable[[], float] = time.monotonic,
                 palette: PaletteStore | None = None,
                 now: Callable[[], datetime] = lambda: datetime.now().astimezone()) -> None:
        self.config = config
        self.palette = palette
        self.unit_count = unit_count
        self.fetch = fetch
        self.clock = clock
        self.now = now
        self.lock = Lock()
        self.stop_event = Event()
        self.worker: Thread | None = None
        self.real: dict[str, Any] = {
            "category": None, "temperatureC": None, "weatherCode": None,
            "observedAt": None, "updatedAt": None, "error": None,
        }
        # Manual test weather: {"category", "temperatureC", "expires"} on self.clock, or None.
        self.override: dict[str, Any] | None = None
        self.category: str | None = None
        self.generation = 0
        # 整點造訪：整點那一格就換成下一個地點的色盤，播放不中斷；天氣分類效果（多雲錯開、雨天線條）
        # 等下一段（單一效果為下一個週期）才套用。造訪持續一輪的時間。讀取失敗沿用上一筆。
        # Hourly visits: on the hour the next location's palette applies at once without restarting; the weather
        # category effects (cloud offsets, rain lines) wait for the next step (next cycle for a single effect). A visit
        # lasts one round of playback time. Failed fetches reuse the last data.
        self.visits: list[Mapping[str, Any]] = list(config.get("visits", []))
        self.visit_weather: list[dict[str, Any] | None] = [None] * len(self.visits)
        self.visit_next = 0
        self.visit: dict[str, Any] | None = None
        # Frames the visit has played (None until the first advance) and its length (one round, captured then).
        self.visit_elapsed: int | None = None
        self.visit_frames = 0
        # An hourly visit begins inside a frame's snapshot (that frame counts); a manual one between frames.
        self.visit_on_hour = False
        # The effective category differs from the applied one until the next step boundary.
        self.category_deferred = False
        self.hour_key: str | None = None

    def _effective_unlocked(self) -> Mapping[str, Any]:
        return self.override or self.visit or self.real

    def _apply_category_unlocked(self) -> None:
        self.category = self._effective_unlocked()["category"]
        self.category_deferred = False

    def _sync_unlocked(self, restart: bool = False) -> None:
        """Restart playback when the effective category changes, or on request; a deferred change waits."""
        if self.category_deferred and not restart:
            return
        if restart or self._effective_unlocked()["category"] != self.category:
            self._apply_category_unlocked()
            self.generation += 1

    def _defer_unlocked(self) -> None:
        """Palette changes now; a different category waits for the next step boundary (see advance)."""
        self.category_deferred = self._effective_unlocked()["category"] != self.category

    def _begin_visit_unlocked(self, index: int, on_hour: bool) -> None:
        self.visit = {"index": index, **self.visit_weather[index]}
        self.visit_elapsed = None
        self.visit_on_hour = on_hour

    def _check_hour_unlocked(self) -> None:
        if not self.visits:
            return
        key = self.now().strftime("%Y-%m-%d %H")
        changed = self.hour_key is not None and key != self.hour_key
        self.hour_key = key
        if not changed or self.override is not None:
            return  # 手動測試天氣期間跳過這個整點，輪替不前進。 / Skipped during manual test weather.
        count = len(self.visits)
        index = next((i % count for i in range(self.visit_next, self.visit_next + count)
                      if self.visit_weather[i % count] is not None), None)
        if index is None:
            return  # No location has ever been fetched.
        self._begin_visit_unlocked(index, on_hour=True)
        self.visit_next = (index + 1) % count
        self._defer_unlocked()

    def _snapshot_unlocked(self) -> dict[str, Any]:
        self._check_hour_unlocked()
        if self.override is not None and self.clock() >= self.override["expires"]:
            self.override = None
            self._sync_unlocked()
        temperature = self._effective_unlocked()["temperatureC"]
        palette = self.palette.palette if self.palette is not None else DEFAULT_PALETTE
        override = None if self.override is None else {
            "category": self.override["category"],
            "temperatureC": self.override["temperatureC"],
            "remainingSeconds": max(0.0, self.override["expires"] - self.clock()),
        }
        return {
            "enabled": True, "category": self.category, "temperatureC": temperature,
            "weatherCode": self.real["weatherCode"], "observedAt": self.real["observedAt"],
            "updatedAt": self.real["updatedAt"],
            # v0.1.10（含）以前的降水延遲，保留欄位給舊前端。 / Rain delays up to v0.1.10, kept for old frontends.
            "startPhases": [0.0] * self.unit_count,
            "frameStep": self.config["cloud_step"] if self.category == "cloudy" else 0,
            "color": gradient_for(temperature, palette) if self.category is not None and temperature is not None else None,
            "generation": self.generation, "error": self.real["error"],
            "override": override,
            "real": {"category": self.real["category"], "temperatureC": self.real["temperatureC"]},
            "source": "override" if self.override is not None else "visit" if self.visit is not None else "local",
            "visit": None if self.visit is None else {
                "name": self.visits[self.visit["index"]]["name"],
                "category": self.visit["category"], "temperatureC": self.visit["temperatureC"],
                "observedAt": self.visit["observedAt"],
            },
            "categoryPending": self.category_deferred,
            "visits": None if not self.visits else {
                "count": len(self.visits),
                "next": self.visits[self.visit_next]["name"],
                "names": [location["name"] for location in self.visits],
            },
            "thresholds": [band["belowC"] for band in palette["bands"][:-1]],
        }

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return self._snapshot_unlocked()

    def set_override(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or set(raw) != {"category", "temperatureC"}:
            raise ValueError("override must contain category and temperatureC")
        category, temperature = raw["category"], raw["temperatureC"]
        if category not in CATEGORIES:
            raise ValueError("category must be clear, cloudy or rain")
        if type(temperature) not in (int, float) or not -100 <= temperature <= 70:
            raise ValueError("temperatureC must be a number in -100..70")
        with self.lock:
            self.override = {
                "category": category, "temperatureC": float(temperature),
                "expires": self.clock() + OVERRIDE_SECONDS,
            }
            # Re-applying always restarts.
            self._sync_unlocked(restart=True)
            return self._snapshot_unlocked()

    def clear_override(self) -> dict[str, Any]:
        with self.lock:
            self.override = None
            self._sync_unlocked()
            return self._snapshot_unlocked()

    def advance(self, frames: int, round_frames: int, boundary: bool, single: bool) -> None:
        """Called by the output loop every frame before reading the snapshot.

        ``frames`` played since the last call, ``round_frames`` of the current playback, and whether a
        step (or, for a single effect, a cycle) boundary was reached. Ends a visit after one round and
        applies a deferred category at a boundary without restarting. ``single`` (a single effect rather
        than a sequence) is unused since rain no longer restarts there.
        """
        with self.lock:
            if self.visit is not None:
                if self.visit_elapsed is None:
                    self.visit_frames = round_frames
                    self.visit_elapsed = frames if self.visit_on_hour else 0
                else:
                    self.visit_elapsed += frames
                if self.visit_elapsed >= self.visit_frames:
                    self.visit = None
                    self._defer_unlocked()
            if boundary and self.category_deferred:
                self._apply_category_unlocked()

    def start_visit(self, raw: Any) -> dict[str, Any]:
        """Test: visit a listed location now, like an hourly visit (palette now, timing at the next step,
        no restart); it lasts one round. Rotation is unchanged."""
        if (not isinstance(raw, dict) or set(raw) != {"index"} or type(raw["index"]) is not int
                or not 0 <= raw["index"] < len(self.visits)):
            raise ValueError("visit must be {\"index\": <listed location>}")
        index = raw["index"]
        with self.lock:
            if self.override is not None:
                raise ValueError("clear the manual test weather first")
        location = self.visits[index]
        try:
            weather: dict[str, Any] | None = self._fetch_weather(location["latitude"], location["longitude"])
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            weather = None  # Fall back to the last good data below.
        with self.lock:
            if weather is not None:
                self.visit_weather[index] = weather
            if self.visit_weather[index] is None:
                raise ValueError(f"no weather data for {location['name']}")
            if self.override is not None:
                raise ValueError("clear the manual test weather first")
            self._begin_visit_unlocked(index, on_hour=False)
            self._defer_unlocked()
            return self._snapshot_unlocked()

    def end_visit(self) -> dict[str, Any]:
        with self.lock:
            if self.visit is not None:
                self.visit = None
                self._defer_unlocked()
            return self._snapshot_unlocked()

    def _fetch_weather(self, latitude: float, longitude: float) -> dict[str, Any]:
        current = self.fetch(latitude, longitude)
        code = current["weather_code"]
        temperature = current["temperature_2m"]
        if type(code) is not int or not isinstance(temperature, (int, float)) or not -100 <= temperature <= 70:
            raise ValueError("invalid weather response")
        return {
            "category": category_for(code), "temperatureC": float(temperature),
            "weatherCode": code, "observedAt": current.get("time"),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }

    def refresh(self) -> None:
        try:
            weather = self._fetch_weather(self.config["latitude"], self.config["longitude"])
            with self.lock:
                self.real.update(weather, error=None)
                self._sync_unlocked()
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            with self.lock:
                self.real["error"] = str(error)

    def refresh_visits(self) -> None:
        """Fetch the next visit location and any never fetched; failures keep the last data."""
        with self.lock:
            indexes = sorted({self.visit_next} | {i for i, weather in enumerate(self.visit_weather) if weather is None}) if self.visits else []
        for index in indexes:
            location = self.visits[index]
            try:
                weather = self._fetch_weather(location["latitude"], location["longitude"])
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                continue
            with self.lock:
                self.visit_weather[index] = weather

    def seconds_until_prefetch(self) -> float:
        """Seconds until the next hh:58 (visit prefetch); infinite without visits."""
        if not self.visits:
            return float("inf")
        now = self.now()
        target = now.replace(minute=VISIT_PREFETCH_MINUTE, second=0, microsecond=0)
        if target <= now:
            target += timedelta(hours=1)
        return (target - now).total_seconds()

    def start(self) -> None:
        def poll() -> None:
            next_local = self.clock()
            while not self.stop_event.is_set():
                if self.clock() >= next_local:
                    self.refresh()
                    next_local = self.clock() + self.config["interval_minutes"] * 60
                self.refresh_visits()
                # 下一次當地輪詢或整點前預先讀取造訪地點，取較早者。 / Next local poll or hh:58 prefetch, whichever is first.
                self.stop_event.wait(max(1.0, min(next_local - self.clock(), self.seconds_until_prefetch())))

        self.worker = Thread(target=poll, daemon=True)
        self.worker.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.worker is not None:
            self.worker.join(timeout=9)
