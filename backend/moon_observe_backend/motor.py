"""Runtime motor and hardware switches: in memory only, so a restart always comes back stopped."""

from __future__ import annotations

from threading import Lock
from typing import Any, Mapping

from .hardware import DIRECTIONS, SPEED_LEVELS

MOTOR_COMMAND_FIELDS = {"unitIds", "speed", "direction"}


class MotorStore:
    """Per-unit speed level and direction, set only through the API (never by sequences)."""

    def __init__(self, motor: Mapping[str, Any], unit_count: int) -> None:
        self.motor = motor
        self.unit_count = unit_count
        self.lock = Lock()
        self.revision = 0
        # 重啟後一律停止；方向回到 cw。 / Never resume a running motor after a restart.
        self._units = [("stop", "cw")] * unit_count

    def snapshot(self) -> tuple[tuple[str, str], ...]:
        """(speed, direction) per unit, index = unit_id - 1."""
        with self.lock:
            return tuple(self._units)

    def apply(self, raw: Any) -> dict[str, Any]:
        unit_ids, speed, direction = self._validate(raw)
        with self.lock:
            updated = [
                (speed or current[0], direction or current[1]) if index + 1 in unit_ids else current
                for index, current in enumerate(self._units)
            ]
            if updated != self._units:
                self._units = updated
                self.revision += 1
            return self._state_unlocked()

    def state(self) -> dict[str, Any]:
        with self.lock:
            return self._state_unlocked()

    def _validate(self, raw: Any) -> tuple[set[int], str | None, str | None]:
        if not isinstance(raw, dict) or not raw.keys() <= MOTOR_COMMAND_FIELDS:
            raise ValueError('motor command must be {"unitIds"?: [...], "speed"?: ..., "direction"?: ...}')
        speed = raw.get("speed")
        direction = raw.get("direction")
        if speed is None and direction is None:
            raise ValueError("motor command needs speed and/or direction")
        if speed is not None and speed not in SPEED_LEVELS:
            raise ValueError(f"motor speed must be one of {', '.join(SPEED_LEVELS)}")
        if direction is not None and direction not in DIRECTIONS:
            raise ValueError(f"motor direction must be one of {', '.join(DIRECTIONS)}")
        if "unitIds" not in raw:
            return set(range(1, self.unit_count + 1)), speed, direction
        unit_ids = raw["unitIds"]
        if (not isinstance(unit_ids, list) or not unit_ids
                or any(type(unit_id) is not int or not 1 <= unit_id <= self.unit_count for unit_id in unit_ids)):
            raise ValueError(f"motor unitIds must be a non-empty list of 1..{self.unit_count}")
        if len(set(unit_ids)) != len(unit_ids):
            raise ValueError("motor unitIds must not repeat")
        return set(unit_ids), speed, direction

    def _state_unlocked(self) -> dict[str, Any]:
        speeds, directions, rpm = self.motor["speeds"], self.motor["directions"], self.motor["rpm"]
        return {
            "revision": self.revision,
            "channels": {"speed": self.motor["speed_channel"], "direction": self.motor["direction_channel"]},
            "levels": {"speeds": dict(speeds), "directions": dict(directions), "rpm": dict(rpm)},
            "units": [
                {
                    "unitId": index + 1, "speed": speed, "direction": direction,
                    "value": speeds[speed], "directionValue": directions[direction],
                    "rpm": 0 if speed == "stop" else rpm[speed],
                }
                for index, (speed, direction) in enumerate(self._units)
            ],
        }


class HardwareStore:
    """Fixed LED output settings plus the moon-correction switch (resets to config on restart)."""

    def __init__(self, hardware: Mapping[str, Any], pixels: int) -> None:
        self.hardware = hardware
        self.pixels = pixels
        self.lock = Lock()
        self._moon_correction = bool(hardware["moon_correction"])

    def moon_correction(self) -> bool:
        with self.lock:
            return self._moon_correction

    def apply(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or set(raw) != {"moonCorrection"} or type(raw["moonCorrection"]) is not bool:
            raise ValueError('hardware command must be {"moonCorrection": true|false}')
        with self.lock:
            self._moon_correction = raw["moonCorrection"]
            return self._state_unlocked()

    def state(self) -> dict[str, Any]:
        with self.lock:
            return self._state_unlocked()

    def _state_unlocked(self) -> dict[str, Any]:
        return {
            "colorOrder": self.hardware["color_order"],
            "brightness": self.hardware["brightness"],
            "moonCorrection": self._moon_correction,
            "moonCorrectionDefault": self.hardware["moon_correction"],
            "pixels": self.pixels,
        }
