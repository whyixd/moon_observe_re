"""Timed shows: the lights play all day; the motors spin only during the show windows, aligned to rounds.

定時播放：排程啟用時燈光全天循環播放；馬達只在表演時段內運轉，並對齊燈光的「輪」：
在「涵蓋時段開始時間的那一輪」開始前 spinUpSeconds 秒先啟動，一直轉到時段結束；時段結束時若一輪還沒播完，
播完這一輪才停。The document is stored in ``schedule.json`` (atomic writes); the state machine is advanced by
the output loop once per frame, and round boundaries come from the playback position.
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

SCHEDULE_SCHEMA_VERSION = 2
SCHEDULE_FIELDS = {"schemaVersion", "enabled", "spinUpSeconds", "motors", "daily", "dates"}
# v1 (v0.2.0) also had rest and end-fade settings; they are dropped when a v1 file is read.
LEGACY_V1_FIELDS = {"restMinutes", "endFadeSeconds"}
SCHEDULE_SPEEDS = ("mid", "max")  # A show always spins; "stop" is what the motors do outside the windows.
MAX_WINDOWS_PER_DAY = 8
MAX_DATES = 400
MAX_SPIN_UP_SECONDS = 30
NEXT_SHOW_HORIZON_DAYS = 400
_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

Motors = tuple[tuple[str, str], ...]


def default_schedule(unit_count: int) -> dict[str, Any]:
    """Used until the first save: disabled, so a missing file keeps today's behaviour."""
    return {
        "schemaVersion": SCHEDULE_SCHEMA_VERSION,
        "enabled": False,
        "spinUpSeconds": 5,
        "motors": [{"unitId": unit_id, "speed": "max", "direction": "cw"} for unit_id in range(1, unit_count + 1)],
        "daily": [{"start": "18:00", "end": "20:00"}],
        "dates": [],
    }


def _number(value: Any, name: str, maximum: float) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or not 0 <= value <= maximum:
        raise ValueError(f"{name} must be a number in 0..{maximum:g}")
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
    """Strict check; a v1 document (v0.2.0) is accepted and returned as v2 without its rest/fade settings."""
    if isinstance(raw, dict) and type(raw.get("schemaVersion")) is int and raw["schemaVersion"] == 1 \
            and set(raw) == SCHEDULE_FIELDS | LEGACY_V1_FIELDS:
        raw = {key: value for key, value in raw.items() if key not in LEGACY_V1_FIELDS}
        raw["schemaVersion"] = SCHEDULE_SCHEMA_VERSION
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
    """What the output loop does this frame: ``motors`` None means the manual motor store decides (disabled).
    The schedule never touches the lights."""

    phase: str
    motors: Motors | None


class Scheduler:
    """Motor state machine, advanced once per output frame by ``output.stream``.

    off → spinup (motors start ``spinUpSeconds`` before the round that covers the window start) → run (until
    the window ends) → finishing (the window ended mid-round: finish that round) → off. Starting mid-window
    (or enabling then) spins at once. Rounds are the looping playback: a round starts whenever the playback
    position is a multiple of the round length, so a playback restart (sequence edit, test weather) moves
    the boundaries and the next ones are recomputed from the new position.
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
        self.armed_for: datetime | None = None   # Window start the motors already started for (kept on).
        self.finish_round: int | None = None     # Round index being finished after the window ended.
        self.last_playback = 0
        self._next_cache: tuple[Mapping[str, Any], datetime, datetime | None] | None = None
        # (phase, frames to phase end, motors, clock, frames to the next motor start, governing window)
        self._sample: tuple[str, int | None, Motors | None, float, int | None,
                            tuple[datetime, datetime] | None] | None = None

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

    def advance(self, round_frames: int, playback_frame: int) -> ScheduleFrame:
        document = self.store.snapshot()
        if not document["enabled"]:
            self.phase = "disabled"
            self.armed_for = None
            self.finish_round = None
            return self._publish(ScheduleFrame("disabled", None), None, None, None)
        now = self.now()
        length = max(1, round_frames)
        position = playback_frame % length
        window = current_window(document, now)
        upcoming = None if window is not None else self._next_show(document, now)
        covering: float | None = None  # Frames until the round that covers the upcoming window start.
        if upcoming is not None:
            lead = (upcoming - now).total_seconds() * self.fps
            covering = math.floor((lead + position) / length) * length - position
        if self.armed_for is not None and self.armed_for != upcoming:
            self.armed_for = None
        spin_frames = document["spinUpSeconds"] * self.fps
        if upcoming is not None and covering is not None and (self.armed_for == upcoming or covering <= spin_frames):
            self.armed_for = upcoming
        previous = self.phase
        remaining: int | None = None
        if window is not None:
            phase = "run"
        elif self.armed_for is not None:
            phase = "spinup" if covering is not None and covering > 0 else "run"
            remaining = math.ceil(covering) if phase == "spinup" else None
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
        self.last_playback = playback_frame
        governing = window if window is not None else (
            current_window(document, upcoming) if upcoming is not None and phase in ("spinup", "run") else None)
        start_in = None if phase != "off" or covering is None else max(0, math.ceil(covering - spin_frames))
        frame = ScheduleFrame(phase, self._motors(document, phase != "off"))
        return self._publish(frame, remaining, start_in, governing)

    def _publish(self, frame: ScheduleFrame, remaining: int | None, start_in: int | None,
                 window: tuple[datetime, datetime] | None) -> ScheduleFrame:
        sample = (frame.phase, remaining, frame.motors, self.clock(), start_in, window)
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
        return {"enabled": enabled, "phase": phase}

    def effective_motors(self) -> Motors | None:
        """Motors the schedule is sending (None when disabled or not running)."""
        with self.lock:
            return None if self._sample is None else self._sample[2]

    def status(self) -> dict[str, Any]:
        document = self.store.snapshot()
        now = self.now()
        with self.lock:
            sample = self._sample
        upcoming = next_show(document, now)

        def at(frames: int | None) -> str | None:
            if frames is None or sample is None:
                return None
            seconds = frames / self.fps - max(0.0, self.clock() - sample[3])
            return (now + timedelta(seconds=max(0.0, seconds))).isoformat(timespec="seconds")

        window = sample[5] if sample is not None else None
        if window is None:
            window = current_window(document, now)
        return {
            "now": now.isoformat(timespec="seconds"),
            "running": sample is not None,
            "phase": ("disabled" if not document["enabled"] else None) if sample is None else sample[0],
            "phaseEndsAt": at(sample[1]) if sample is not None and sample[0] != "disabled" else None,
            "window": None if window is None else {"start": window[0].isoformat(timespec="minutes"),
                                                   "end": window[1].isoformat(timespec="minutes")},
            "today": [{"start": start.strftime("%H:%M"), "end": "24:00" if end.date() > now.date() else end.strftime("%H:%M")}
                      for start, end in windows_on(document, now.date())],
            "nextShowAt": None if upcoming is None else upcoming.isoformat(timespec="minutes"),
            "motorStartAt": at(sample[4]) if sample is not None else None,
        }
