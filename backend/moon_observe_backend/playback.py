"""Latest output-loop frame, published for the read-only playback API."""

from __future__ import annotations

from threading import Lock
import time
from typing import Any, Callable, Mapping

from .effects import completion_frames
from .sequence import sequence_position


class PlaybackMonitor:
    def __init__(self, fps: int, unit_count: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.fps = fps
        self.unit_count = unit_count
        self.clock = clock
        self.lock = Lock()
        self._sample: tuple[str, Any, int, int, float] | None = None

    def report(self, mode: str, schedule: Any, restart: int, frame: int) -> None:
        """Called once per output frame; derived fields are computed only on read."""
        sample = (mode, schedule, restart, frame, self.clock())
        with self.lock:
            self._sample = sample

    def stop(self) -> None:
        with self.lock:
            self._sample = None

    def state(self) -> dict[str, Any]:
        with self.lock:
            sample = self._sample
        if sample is None:
            return {"active": False}
        mode, schedule, restart, frame, sampled_at = sample
        result: dict[str, Any] = {
            "active": True, "mode": mode, "restart": restart, "fps": self.fps,
            "ageMs": max(0, round((self.clock() - sampled_at) * 1000)),
        }
        if mode == "sequence":
            result.update(sequence_position(schedule, frame))
        else:
            result.update(_single_position(schedule, frame, self.fps, self.unit_count))
        return result


def _single_position(preset: Mapping[str, Any], frame: int, fps: int, unit_count: int) -> dict[str, Any]:
    cycle = completion_frames(preset, fps, unit_count)
    return {
        "frame": frame,
        "effectId": preset["effectId"],
        "cycle": {"current": frame // cycle + 1, "elapsed": frame % cycle, "frames": cycle} if cycle else None,
    }
