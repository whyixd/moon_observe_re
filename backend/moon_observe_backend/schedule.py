"""Timed shows: the lights play all day; the motors follow the show windows.

定時播放：排程啟用時燈光全天循環播放，排程只控制馬達。每個時段各自選模式：
- 持續（continuous）：在「涵蓋時段開始時間的那一輪」開始前 spinUpSeconds 秒先啟動，一直轉到時段結束；
  結束時若這一輪還沒播完，播完才停。
- 循環（cycle）：時段開始時馬達啟動，暖機 spinUpSeconds 秒後燈光從第 1 段播放一輪，播完休息 restMinutes 分鐘
  （馬達停、燈照常），休息後再暖機、從第 1 段重播；時段結束時馬達立刻停止。
The document is stored in ``schedule.json`` (atomic writes); the state machine is advanced by the output loop once
per frame. Continuous windows align to the looping playback's rounds; cycle windows count output frames.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import json
import math
import os
from pathlib import Path
import re
import tempfile
from threading import Lock
import time
from typing import Any, Callable, Mapping

from .hardware import DIRECTIONS

SCHEDULE_SCHEMA_VERSION = 3
SCHEDULE_FIELDS = {"schemaVersion", "enabled", "spinUpSeconds", "motors", "daily", "dates"}
# v1 (v0.2.0): every window cycled with one restMinutes, plus an end fade. v2 (v0.3.0): every window continuous.
LEGACY_V1_FIELDS = {"restMinutes", "endFadeSeconds"}
WINDOW_MODES = ("continuous", "cycle")
SCHEDULE_SPEEDS = ("mid", "max")  # A show always spins; "stop" is what the motors do outside the windows.
MAX_WINDOWS_PER_DAY = 8
MAX_DATES = 400
MAX_SPIN_UP_SECONDS = 30
MAX_REST_MINUTES = 240
NEXT_SHOW_HORIZON_DAYS = 400
_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

Motors = tuple[tuple[str, str], ...]
Spec = tuple[str, int | None]  # (mode, restMinutes for cycle windows)
Window = tuple[datetime, datetime, Spec]


def default_schedule(unit_count: int) -> dict[str, Any]:
    """Used until the first save: disabled, so a missing file keeps today's behaviour."""
    return {
        "schemaVersion": SCHEDULE_SCHEMA_VERSION,
        "enabled": False,
        "spinUpSeconds": 5,
        "motors": [{"unitId": unit_id, "speed": "max", "direction": "cw"} for unit_id in range(1, unit_count + 1)],
        "daily": [{"start": "18:00", "end": "20:00", "mode": "continuous"}],
        "dates": [],
    }


def _number(value: Any, name: str, maximum: float, *, integer: bool = False) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int if integer else (int, float)) \
            or value != value or not 0 <= value <= maximum:
        raise ValueError(f"{name} must be {'an integer' if integer else 'a number'} in 0..{maximum:g}")
    return value


def _minutes(value: Any, name: str, *, end: bool) -> int:
    if not isinstance(value, str) or not (_TIME.match(value) or (end and value == "24:00")):
        raise ValueError(f"{name} must be HH:MM" + (" (00:00..24:00)" if end else " (00:00..23:59)"))
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def _windows(raw: Any, name: str) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or len(raw) > MAX_WINDOWS_PER_DAY:
        raise ValueError(f"{name} must list at most {MAX_WINDOWS_PER_DAY} windows")
    windows = []
    for index, window in enumerate(raw):
        label = f"{name}[{index}]"
        mode = window.get("mode") if isinstance(window, dict) else None
        keys = {"start", "end", "mode"} | ({"restMinutes"} if mode == "cycle" else set())
        if not isinstance(window, dict) or mode not in WINDOW_MODES or set(window) != keys:
            raise ValueError(f"{label} must be {{\"start\", \"end\", \"mode\": \"continuous\"}} "
                             f"or {{\"start\", \"end\", \"mode\": \"cycle\", \"restMinutes\"}}")
        start = _minutes(window["start"], f"{label}.start", end=False)
        finish = _minutes(window["end"], f"{label}.end", end=True)
        if finish <= start:
            raise ValueError(f"{label} must end after it starts (windows do not cross midnight)")
        clean: dict[str, Any] = {"start": window["start"], "end": window["end"], "mode": mode}
        if mode == "cycle":
            clean["restMinutes"] = _number(window["restMinutes"], f"{label}.restMinutes", MAX_REST_MINUTES, integer=True)
        windows.append((start, finish, clean))
    windows.sort(key=lambda item: item[0])
    for previous, current in zip(windows, windows[1:]):
        if current[0] < previous[1]:
            raise ValueError(f"{name} windows must not overlap")
    return [window for _, _, window in windows]


def _upgrade(raw: Any) -> Any:
    """v1 → every window cycles with its restMinutes; v2 → every window continuous. Others pass through."""
    if not isinstance(raw, dict) or type(raw.get("schemaVersion")) is not int:
        return raw
    if raw["schemaVersion"] == 1 and set(raw) == SCHEDULE_FIELDS | LEGACY_V1_FIELDS:
        extra: dict[str, Any] = {"mode": "cycle", "restMinutes": raw["restMinutes"]}
    elif raw["schemaVersion"] == 2 and set(raw) == SCHEDULE_FIELDS:
        extra = {"mode": "continuous"}
    else:
        return raw

    def windows(items: Any) -> Any:
        if not isinstance(items, list):
            return items
        return [{**item, **extra} if isinstance(item, dict) and set(item) == {"start", "end"} else item
                for item in items]

    dates = raw["dates"]
    if isinstance(dates, list):
        dates = [{**entry, "windows": windows(entry["windows"])} if isinstance(entry, dict) and "windows" in entry
                 else entry for entry in dates]
    upgraded = {key: value for key, value in raw.items() if key not in LEGACY_V1_FIELDS}
    upgraded.update(schemaVersion=SCHEDULE_SCHEMA_VERSION, daily=windows(raw["daily"]), dates=dates)
    return upgraded


def validate_schedule(raw: Any, unit_count: int) -> dict[str, Any]:
    """Strict check; v1 (v0.2.0) and v2 (v0.3.0) documents are accepted and returned as v3."""
    raw = _upgrade(raw)
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
        "spinUpSeconds": _number(raw["spinUpSeconds"], "schedule spinUpSeconds", MAX_SPIN_UP_SECONDS),
        "motors": [by_unit[unit_id] for unit_id in sorted(by_unit)],
        "daily": _windows(raw["daily"], "schedule daily"),
        "dates": [dates[day] for day in sorted(dates)],
    }


def _spec(window: Mapping[str, Any]) -> Spec:
    return window["mode"], window.get("restMinutes")


def windows_on(document: Mapping[str, Any], day: date) -> list[Window]:
    """That day's show windows: its special date entry when listed (possibly none), else the daily windows."""
    key = day.isoformat()
    windows = next((entry["windows"] for entry in document["dates"] if entry["date"] == key), document["daily"])
    midnight = datetime.combine(day, datetime.min.time())
    return [
        (midnight + timedelta(minutes=_minutes(window["start"], "start", end=False)),
         midnight + timedelta(minutes=_minutes(window["end"], "end", end=True)), _spec(window))
        for window in windows
    ]


def current_window(document: Mapping[str, Any], now: datetime) -> Window | None:
    """The window containing ``now`` (start inclusive, end exclusive); adjacent windows with the same mode
    (and rest) merge, e.g. 18:00–19:00 + 19:00–20:00 or 22:00–24:00 + 00:00–02:00 the next day."""
    windows = windows_on(document, now.date())
    found = next((window for window in windows if window[0] <= now < window[1]), None)
    if found is None:
        return None
    start, end, spec = found
    while True:
        following = next((window for window in windows_on(document, end.date()) if window[0] == end), None)
        if following is None or following[2] != spec or following[1] <= end:
            return start, end, spec
        end = following[1]


def next_show(document: Mapping[str, Any], now: datetime) -> datetime | None:
    """The next window start after ``now`` that does not continue the window before it."""
    for offset in range(NEXT_SHOW_HORIZON_DAYS):
        for start, _, _ in windows_on(document, now.date() + timedelta(days=offset)):
            if start > now:
                before = current_window(document, start - timedelta(minutes=1))
                if before is None or before[1] <= start:
                    return start
    return None


def window_json(window: Window | None) -> dict[str, Any] | None:
    if window is None:
        return None
    result: dict[str, Any] = {"start": window[0].isoformat(timespec="minutes"),
                              "end": window[1].isoformat(timespec="minutes"), "mode": window[2][0]}
    if window[2][0] == "cycle":
        result["restMinutes"] = window[2][1]
    return result


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

    ``motors`` None means the manual motor store decides (disabled). ``restart`` replays the sequence from
    step 1 starting this frame (cycle windows). The schedule never dims or blacks out the lights.
    """

    phase: str
    motors: Motors | None
    restart: bool = False


CYCLE_PHASES = ("spinup", "play", "rest")


class Scheduler:
    """Motor state machine, advanced once per output frame by ``output.stream``.

    Continuous window: off → spinup (``spinUpSeconds`` before the round that covers the window start) → run →
    finishing (the window ended mid-round: finish it) → off. Rounds are the looping playback: a round starts
    whenever the playback position is a multiple of the round length, so a playback restart moves the
    boundaries and the next ones are recomputed.

    Cycle window: spinup (``spinUpSeconds``) → play (restart from step 1, one round) → rest (``restMinutes``)
    → spinup → …; ``restMinutes`` 0 replays at once without spin-up. The window end stops the motors at once.

    Starting mid-window (or enabling then) behaves like the window start: continuous spins at once, cycle
    spins up and then replays from step 1.
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
        self.mode: str | None = None              # "continuous" / "cycle" while the motors follow a window.
        self.cycle_window: Window | None = None   # The cycle window being played.
        self.elapsed = 0                          # Output frames in the current cycle phase.
        self.round = 0                            # Rounds started in the current cycle window.
        self.armed_for: datetime | None = None    # Continuous window start the motors already started for.
        self.finish_round: int | None = None      # Round index being finished after a continuous window.
        self.last_playback = 0
        self._next_cache: tuple[Mapping[str, Any], datetime, datetime | None] | None = None
        # (phase, mode, round, frames to phase end, motors, clock, frames to next motor start, window)
        self._sample: tuple[str, str | None, int | None, int | None, Motors | None, float, int | None,
                            Window | None] | None = None

    def _motors(self, document: Mapping[str, Any], spinning: bool) -> Motors:
        return tuple((motor["speed"] if spinning else "stop", motor["direction"]) for motor in document["motors"])

    def _next_show(self, document: Mapping[str, Any], now: datetime) -> datetime | None:
        """next_show, cached per document and minute (window starts are whole minutes)."""
        minute = now.replace(second=0, microsecond=0)
        cache = self._next_cache
        if cache is None or cache[0] is not document or cache[1] != minute \
                or (cache[2] is not None and cache[2] <= now):
            cache = (document, minute, next_show(document, now))
            self._next_cache = cache
        return cache[2]

    def _enter(self, phase: str) -> None:
        self.phase = phase
        self.elapsed = 0

    def advance(self, frames: int, round_frames: int, playback_frame: int) -> ScheduleFrame:
        document = self.store.snapshot()
        if not document["enabled"]:
            self.phase, self.mode, self.cycle_window = "disabled", None, None
            self.armed_for = self.finish_round = None
            return self._publish(ScheduleFrame("disabled", None), None, None, None, None)
        now = self.now()
        window = current_window(document, now)
        if window is not None and window[2][0] == "cycle":
            return self._cycle(document, window, frames, round_frames, playback_frame)
        return self._continuous(document, now, window, round_frames, playback_frame)

    def _cycle(self, document: Mapping[str, Any], window: Window, frames: int, round_frames: int,
               playback_frame: int) -> ScheduleFrame:
        spin_frames = max(0, round(document["spinUpSeconds"] * self.fps))
        rest_frames = window[2][1] * 60 * self.fps
        if self.mode != "cycle" or self.cycle_window != window:
            self.mode, self.cycle_window, self.round = "cycle", window, 0
            self.armed_for = self.finish_round = None
            self._enter("spinup")
        else:
            self.elapsed += max(0, frames)
            if self.phase == "play" and playback_frame >= round_frames:
                if rest_frames == 0:
                    self._enter("spinup")  # Motors never stopped: replay at once below.
                    self.elapsed = spin_frames
                else:
                    self._enter("rest")
            elif self.phase == "rest" and self.elapsed >= rest_frames:
                self._enter("spinup")
        restart = False
        if self.phase == "spinup" and self.elapsed >= spin_frames:
            self.round += 1
            self._enter("play")
            restart = True
        remaining = {
            "spinup": spin_frames - self.elapsed,
            "play": round_frames - (0 if restart else playback_frame),
            "rest": rest_frames - self.elapsed,
        }[self.phase]
        self.last_playback = 0 if restart else playback_frame
        frame = ScheduleFrame(self.phase, self._motors(document, self.phase != "rest"), restart)
        return self._publish(frame, self.round, max(0, remaining), None, window)

    def _continuous(self, document: Mapping[str, Any], now: datetime, window: Window | None, round_frames: int,
                    playback_frame: int) -> ScheduleFrame:
        if self.mode == "cycle":  # A cycle window just ended: its motors stop at once.
            self.phase, self.mode, self.cycle_window = "off", None, None
        length = max(1, round_frames)
        position = playback_frame % length
        upcoming = None if window is not None else self._next_show(document, now)
        upcoming_window = current_window(document, upcoming) if upcoming is not None else None
        covering: float | None = None  # Frames until the round that covers the upcoming window start.
        if upcoming_window is not None and upcoming_window[2][0] == "continuous":
            lead = (upcoming - now).total_seconds() * self.fps
            covering = math.floor((lead + position) / length) * length - position
        elif upcoming is None or upcoming_window is None:
            upcoming = None
        if self.armed_for is not None and (self.armed_for != upcoming or covering is None):
            self.armed_for = None
        spin_frames = document["spinUpSeconds"] * self.fps
        if covering is not None and (self.armed_for == upcoming or covering <= spin_frames):
            self.armed_for = upcoming
        previous = self.phase
        remaining: int | None = None
        if window is not None:
            phase = "run"
        elif self.armed_for is not None:
            phase = "spinup" if covering is not None and covering > 0 else "run"
            remaining = math.ceil(covering) if phase == "spinup" and covering is not None else None
        elif previous == "run" and position != 0:
            phase = "finishing"
            self.finish_round = playback_frame // length
        elif previous == "finishing" and playback_frame >= self.last_playback \
                and playback_frame // length == self.finish_round:
            phase = "finishing"
        else:
            phase = "off"
        if phase == "finishing":
            remaining = length - position
        else:
            self.finish_round = None
        self.phase = phase
        self.mode = None if phase == "off" else "continuous"
        self.last_playback = playback_frame
        governing = window if window is not None else (upcoming_window if phase in ("spinup", "run") else None)
        if phase != "off":
            start_in = None
        elif covering is not None:
            start_in = max(0, math.ceil(covering - spin_frames))
        elif upcoming is not None:
            start_in = max(0, math.ceil((upcoming - now).total_seconds() * self.fps))  # Cycle: at its start.
        else:
            start_in = None
        frame = ScheduleFrame(phase, self._motors(document, phase != "off"))
        return self._publish(frame, None, remaining, start_in, governing)

    def _publish(self, frame: ScheduleFrame, rounds: int | None, remaining: int | None, start_in: int | None,
                 window: Window | None) -> ScheduleFrame:
        sample = (frame.phase, self.mode, rounds or None, remaining, frame.motors, self.clock(), start_in, window)
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
        return {"enabled": enabled, "phase": phase, "mode": sample[1] if sample is not None else None}

    def effective_motors(self) -> Motors | None:
        """Motors the schedule is sending (None when disabled or not running)."""
        with self.lock:
            return None if self._sample is None else self._sample[4]

    def status(self) -> dict[str, Any]:
        document = self.store.snapshot()
        now = self.now()
        with self.lock:
            sample = self._sample
        upcoming = next_show(document, now)

        def at(frames: int | None) -> str | None:
            if frames is None or sample is None:
                return None
            seconds = frames / self.fps - max(0.0, self.clock() - sample[5])
            return (now + timedelta(seconds=max(0.0, seconds))).isoformat(timespec="seconds")

        window = sample[7] if sample is not None else None
        if window is None:
            window = current_window(document, now)
        today = []
        for start, end, spec in windows_on(document, now.date()):
            entry: dict[str, Any] = {"start": start.strftime("%H:%M"),
                                     "end": "24:00" if end.date() > now.date() else end.strftime("%H:%M"),
                                     "mode": spec[0]}
            if spec[0] == "cycle":
                entry["restMinutes"] = spec[1]
            today.append(entry)
        running = sample is not None and sample[0] != "disabled"
        return {
            "now": now.isoformat(timespec="seconds"),
            "running": sample is not None,
            "phase": ("disabled" if not document["enabled"] else None) if sample is None else sample[0],
            "mode": sample[1] if running else None,
            "round": sample[2] if running else None,
            "phaseEndsAt": at(sample[3]) if running else None,
            "window": window_json(window),
            "today": today,
            "nextShowAt": None if upcoming is None else upcoming.isoformat(timespec="minutes"),
            "motorStartAt": at(sample[6]) if running else None,
        }
