"""Timed shows: daily and per-date show windows, play one round, rest with motors stopped, spin up, repeat.

定時播放：表演時段內「暖機 → 播放一輪 → 休息（只停馬達）→ 暖機 → …」，時段外送全 0。
The document is stored in ``schedule.json`` (atomic writes); the state machine is advanced by the output loop
once per frame, so every duration except the show windows is counted in output frames.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
import re
import tempfile
from threading import Lock
import time
from typing import Any, Callable, Mapping

from .hardware import DIRECTIONS

SCHEDULE_SCHEMA_VERSION = 1
SCHEDULE_FIELDS = {"schemaVersion", "enabled", "restMinutes", "spinUpSeconds", "endFadeSeconds", "motors", "daily", "dates"}
SCHEDULE_SPEEDS = ("mid", "max")  # A show always spins; "stop" is what rest and off use.
MAX_WINDOWS_PER_DAY = 8
MAX_DATES = 400
MAX_REST_MINUTES = 240
MAX_SPIN_UP_SECONDS = 30
MAX_END_FADE_SECONDS = 10
NEXT_SHOW_HORIZON_DAYS = 400
_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

Motors = tuple[tuple[str, str], ...]


def default_schedule(unit_count: int) -> dict[str, Any]:
    """Used until the first save: disabled, so a missing file keeps today's behaviour."""
    return {
        "schemaVersion": SCHEDULE_SCHEMA_VERSION,
        "enabled": False,
        "restMinutes": 10,
        "spinUpSeconds": 5,
        "endFadeSeconds": 3,
        "motors": [{"unitId": unit_id, "speed": "max", "direction": "cw"} for unit_id in range(1, unit_count + 1)],
        "daily": [{"start": "18:00", "end": "20:00"}],
        "dates": [],
    }


def _number(value: Any, name: str, maximum: float, *, integer: bool = False) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int if integer else (int, float)) \
            or value != value or not 0 <= value <= maximum:
        kind = "an integer" if integer else "a number"
        raise ValueError(f"{name} must be {kind} in 0..{maximum:g}")
    return value


def _minutes(value: Any, name: str, *, end: bool) -> int:
    if not isinstance(value, str) or not (_TIME.match(value) or (end and value == "24:00")):
        raise ValueError(f"{name} must be HH:MM" + (" (00:00..24:00)" if end else " (00:00..23:59)"))
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def _windows(raw: Any, name: str) -> list[dict[str, str]]:
    if not isinstance(raw, list) or len(raw) > MAX_WINDOWS_PER_DAY:
        raise ValueError(f"{name} must list at most {MAX_WINDOWS_PER_DAY} windows")
    windows = []
    for index, window in enumerate(raw):
        label = f"{name}[{index}]"
        if not isinstance(window, dict) or set(window) != {"start", "end"}:
            raise ValueError(f"{label} must be {{\"start\": \"HH:MM\", \"end\": \"HH:MM\"}}")
        start = _minutes(window["start"], f"{label}.start", end=False)
        finish = _minutes(window["end"], f"{label}.end", end=True)
        if finish <= start:
            raise ValueError(f"{label} must end after it starts (windows do not cross midnight)")
        windows.append((start, finish, {"start": window["start"], "end": window["end"]}))
    windows.sort(key=lambda item: item[0])
    for previous, current in zip(windows, windows[1:]):
        if current[0] < previous[1]:
            raise ValueError(f"{name} windows must not overlap")
    return [window for _, _, window in windows]


def validate_schedule(raw: Any, unit_count: int) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != SCHEDULE_FIELDS:
        raise ValueError(f"schedule must contain exactly {', '.join(sorted(SCHEDULE_FIELDS))}")
    if type(raw["schemaVersion"]) is not int or raw["schemaVersion"] != SCHEDULE_SCHEMA_VERSION:
        raise ValueError("unsupported schedule schemaVersion")
    if type(raw["enabled"]) is not bool:
        raise ValueError("schedule enabled must be true or false")
    motors = raw["motors"]
    if not isinstance(motors, list) or len(motors) != unit_count:
        raise ValueError(f"schedule motors must list all {unit_count} units")
    by_unit: dict[int, dict[str, Any]] = {}
    for index, motor in enumerate(motors):
        if not isinstance(motor, dict) or set(motor) != {"unitId", "speed", "direction"}:
            raise ValueError(f"schedule motors[{index}] must contain unitId, speed and direction")
        unit_id = motor["unitId"]
        if type(unit_id) is not int or not 1 <= unit_id <= unit_count or unit_id in by_unit:
            raise ValueError(f"schedule motor unitIds must be distinct 1..{unit_count}")
        if motor["speed"] not in SCHEDULE_SPEEDS:
            raise ValueError(f"schedule motor speed must be one of {', '.join(SCHEDULE_SPEEDS)}")
        if motor["direction"] not in DIRECTIONS:
            raise ValueError(f"schedule motor direction must be one of {', '.join(DIRECTIONS)}")
        by_unit[unit_id] = {"unitId": unit_id, "speed": motor["speed"], "direction": motor["direction"]}
    dates_raw = raw["dates"]
    if not isinstance(dates_raw, list) or len(dates_raw) > MAX_DATES:
        raise ValueError(f"schedule dates must list at most {MAX_DATES} days")
    dates: dict[str, dict[str, Any]] = {}
    for index, entry in enumerate(dates_raw):
        if not isinstance(entry, dict) or set(entry) != {"date", "windows"}:
            raise ValueError(f"schedule dates[{index}] must contain date and windows")
        day = entry["date"]
        try:
            valid = isinstance(day, str) and date.fromisoformat(day).isoformat() == day
        except ValueError:
            valid = False
        if not valid:
            raise ValueError(f"schedule dates[{index}].date must be YYYY-MM-DD")
        if day in dates:
            raise ValueError(f"schedule date {day} is listed twice")
        dates[day] = {"date": day, "windows": _windows(entry["windows"], f"schedule dates[{index}].windows")}
    return {
        "schemaVersion": SCHEDULE_SCHEMA_VERSION,
        "enabled": raw["enabled"],
        "restMinutes": _number(raw["restMinutes"], "schedule restMinutes", MAX_REST_MINUTES, integer=True),
        "spinUpSeconds": _number(raw["spinUpSeconds"], "schedule spinUpSeconds", MAX_SPIN_UP_SECONDS),
        "endFadeSeconds": _number(raw["endFadeSeconds"], "schedule endFadeSeconds", MAX_END_FADE_SECONDS),
        "motors": [by_unit[unit_id] for unit_id in sorted(by_unit)],
        "daily": _windows(raw["daily"], "schedule daily"),
        "dates": [dates[day] for day in sorted(dates)],
    }


def windows_on(document: Mapping[str, Any], day: date) -> list[tuple[datetime, datetime]]:
    """That day's show windows: its special date entry when listed (possibly none), else the daily windows."""
    key = day.isoformat()
    windows = next((entry["windows"] for entry in document["dates"] if entry["date"] == key), document["daily"])
    midnight = datetime.combine(day, datetime.min.time())
    return [
        (midnight + timedelta(minutes=_minutes(window["start"], "start", end=False)),
         midnight + timedelta(minutes=_minutes(window["end"], "end", end=True)))
        for window in windows
    ]


def current_window(document: Mapping[str, Any], now: datetime) -> tuple[datetime, datetime] | None:
    """The window containing ``now`` (start inclusive, end exclusive); adjacent windows merge."""
    windows = windows_on(document, now.date())
    found = next(((start, end) for start, end in windows if start <= now < end), None)
    if found is None:
        return None
    start, end = found
    while True:  # 18:00–19:00 + 19:00–20:00 or 22:00–24:00 + 00:00–02:00 next day play as one window.
        following = next((window for window in windows_on(document, end.date()) if window[0] == end), None)
        if following is None or following[1] <= end:
            return start, end
        end = following[1]


def next_show(document: Mapping[str, Any], now: datetime) -> datetime | None:
    """The next window start after ``now`` that does not continue the current window."""
    for offset in range(NEXT_SHOW_HORIZON_DAYS):
        for start, _ in windows_on(document, now.date() + timedelta(days=offset)):
            if start > now and current_window(document, start - timedelta(minutes=1)) is None:
                return start
    return None


class ScheduleStore:
    """schedule.json with atomic writes; a missing file means the disabled default (written on first save)."""

    def __init__(self, path: str | Path, unit_count: int) -> None:
        self.path = Path(path)
        self.unit_count = unit_count
        self.lock = Lock()
        self.revision = 0
        if self.path.exists():
            self.document = validate_schedule(json.loads(self.path.read_text(encoding="utf-8")), unit_count)
        else:
            self.document = default_schedule(unit_count)

    def snapshot(self) -> Mapping[str, Any]:
        with self.lock:
            return self.document

    def enabled(self) -> bool:
        with self.lock:
            return self.document["enabled"]

    def state(self) -> dict[str, Any]:
        with self.lock:
            return {"revision": self.revision, "schedule": copy.deepcopy(self.document)}

    def apply(self, raw: Any) -> dict[str, Any]:
        document = validate_schedule(raw, self.unit_count)
        encoded = (json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        with self.lock:
            temporary: str | None = None
            try:
                with tempfile.NamedTemporaryFile(mode="wb", prefix=".schedule-", suffix=".tmp",
                                                 dir=self.path.parent, delete=False) as stream:
                    temporary = stream.name
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
                temporary = None
            finally:
                if temporary is not None:
                    Path(temporary).unlink(missing_ok=True)
            self.document = document
            self.revision += 1
            return {"revision": self.revision, "schedule": copy.deepcopy(document)}


@dataclass(frozen=True)
class ScheduleFrame:
    """What the output loop does this frame.

    ``motors`` None means the manual motor store decides (schedule disabled). ``light`` scales the rendered
    pixels (0 = dark). ``restart`` replays the sequence from step 1 starting this frame. ``blackout`` sends the
    all-zero frame (outside the show windows).
    """

    phase: str
    motors: Motors | None
    light: float
    restart: bool
    blackout: bool


class Scheduler:
    """Show state machine, advanced once per output frame by ``output.stream``.

    disabled → (enabled) → spinup (dark) → play → rest → spinup (lit) → play → …; leaving the show window from
    any show phase → ending (motors stop, lights fade) → off (all zero). Spin-up, rest and the end fade count
    output frames; a round ends when the playback position reaches the round length.
    """

    def __init__(self, store: ScheduleStore, fps: int, unit_count: int,
                 now: Callable[[], datetime] = datetime.now, clock: Callable[[], float] = time.monotonic) -> None:
        self.store = store
        self.fps = fps
        self.unit_count = unit_count
        self.now = now
        self.clock = clock
        self.lock = Lock()
        self.phase = "disabled"
        self.elapsed = 0          # Output frames spent in the current phase.
        self.round = 0            # Rounds started in the current show window.
        self.lit_spinup = False   # Spin-up after a rest keeps the lights playing; after "off" it stays dark.
        self.fade_from = 1.0      # Light level when the end fade began.
        self._sample: tuple[str, int, int | None, Motors | None, float] | None = None

    def _frames(self, seconds: float) -> int:
        return max(0, round(seconds * self.fps))

    def _motors(self, document: Mapping[str, Any], spinning: bool) -> Motors:
        return tuple((motor["speed"] if spinning else "stop", motor["direction"]) for motor in document["motors"])

    def _enter(self, phase: str) -> None:
        self.phase = phase
        self.elapsed = 0

    def advance(self, frames: int, round_frames: int, playback_frame: int) -> ScheduleFrame:
        document = self.store.snapshot()
        if not document["enabled"]:
            self._enter("disabled")
            return self._publish(document, ScheduleFrame("disabled", None, 1.0, False, False), None)
        in_window = current_window(document, self.now()) is not None
        spin_frames = self._frames(document["spinUpSeconds"])
        rest_frames = document["restMinutes"] * 60 * self.fps
        fade_frames = self._frames(document["endFadeSeconds"])
        restart = False
        if self.phase == "disabled":
            self.round = 0
            self.lit_spinup = False
            self._enter("spinup" if in_window else "off")
        else:
            self.elapsed += max(0, frames)
            if in_window and self.phase in ("off", "ending"):
                self.round = 0
                self.lit_spinup = False
                self._enter("spinup")
            elif not in_window and self.phase in ("spinup", "play", "rest"):
                self.fade_from = self._light(1.0)
                self._enter("ending")
            elif self.phase == "play" and playback_frame >= round_frames:
                if rest_frames == 0:
                    self._enter("spinup")  # Motors never stopped: no spin-up needed, replay at once below.
                    self.lit_spinup = True
                    self.elapsed = spin_frames
                else:
                    self._enter("rest")
            elif self.phase == "rest" and self.elapsed >= rest_frames:
                self.lit_spinup = True
                self._enter("spinup")
        # Zero-length phases fall through in the same frame.
        if self.phase == "spinup" and self.elapsed >= spin_frames:
            self.round += 1
            self._enter("play")
            restart = True
        if self.phase == "ending" and self.elapsed >= fade_frames:
            self._enter("off")
        phase = self.phase
        if phase == "off":
            frame = ScheduleFrame(phase, self._motors(document, False), 0.0, False, True)
        elif phase == "ending":
            weight = self.fade_from * max(0.0, 1 - (self.elapsed + 1) / fade_frames) if fade_frames else 0.0
            frame = ScheduleFrame(phase, self._motors(document, False), weight, False, False)
        else:
            frame = ScheduleFrame(phase, self._motors(document, phase in ("spinup", "play")),
                                  self._light(1.0), restart, False)
        remaining = {
            "spinup": spin_frames - self.elapsed,
            "play": round_frames - (0 if restart else playback_frame),
            "rest": rest_frames - self.elapsed,
            "ending": fade_frames - self.elapsed,
        }.get(phase)
        return self._publish(document, frame, remaining)

    def _light(self, lit: float) -> float:
        return 0.0 if self.phase == "spinup" and not self.lit_spinup else lit

    def _publish(self, document: Mapping[str, Any], frame: ScheduleFrame, remaining: int | None) -> ScheduleFrame:
        sample = (frame.phase, self.round, None if remaining is None else max(0, remaining), frame.motors, self.clock())
        with self.lock:
            self._sample = sample
        return frame

    def stop(self) -> None:
        with self.lock:
            self._sample = None

    def summary(self) -> dict[str, Any]:
        """Cheap per-poll view for /api/state and /api/playback."""
        with self.lock:
            sample = self._sample
        enabled = self.store.enabled()
        phase = sample[0] if sample is not None else ("disabled" if not enabled else None)
        return {"enabled": enabled, "phase": phase,
                "round": sample[1] if sample is not None and phase in ("spinup", "play", "rest") and sample[1] else None}

    def effective_motors(self) -> Motors | None:
        """Motors the schedule is sending (None when disabled or not running)."""
        with self.lock:
            return None if self._sample is None else self._sample[3]

    def status(self) -> dict[str, Any]:
        document = self.store.snapshot()
        now = self.now()
        with self.lock:
            sample = self._sample
        window = current_window(document, now)
        upcoming = next_show(document, now)
        result: dict[str, Any] = {
            "now": now.isoformat(timespec="seconds"),
            "running": sample is not None,
            "phase": ("disabled" if not document["enabled"] else None) if sample is None else sample[0],
            "round": None,
            "phaseEndsAt": None,
            "window": None if window is None else {"start": window[0].isoformat(timespec="minutes"),
                                                   "end": window[1].isoformat(timespec="minutes")},
            "today": [{"start": start.strftime("%H:%M"), "end": "24:00" if end.date() > now.date() else end.strftime("%H:%M")}
                      for start, end in windows_on(document, now.date())],
            "nextShowAt": None if upcoming is None else upcoming.isoformat(timespec="minutes"),
        }
        if sample is not None and sample[0] != "disabled":
            phase, rounds, remaining, _, sampled_at = sample
            result["round"] = rounds if phase in ("spinup", "play", "rest") and rounds else None
            if remaining is not None:
                seconds = remaining / self.fps - max(0.0, self.clock() - sampled_at)
                result["phaseEndsAt"] = (now + timedelta(seconds=max(0.0, seconds))).isoformat(timespec="seconds")
        return result
