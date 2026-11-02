"""Shared test configs shaped like load_config() output."""

from moon_observe_backend.config import DEFAULT_HARDWARE, DEFAULT_MOTOR


def reference_config(**overrides):
    """The reference system's 156 LEDs x 9 units on one target.

    RGB at full brightness without moon correction and with the motor moved to channels 469/470, so a
    frame's first 468 bytes equal ``rgb_bytes(render_frame(...))`` exactly as in the reference tests.
    參考系統的 156 顆 × 9 台；像素位元組與 rgb_bytes 相同。
    """
    config = {
        "source_ip": None, "fps": 40, "rpm": 360, "pixels": 156, "unit_count": 9,
        "targets": [{"unit_id": 1, "ip": "127.0.0.1", "universes": [0]}],
        "hardware": {"color_order": "RGB", "brightness": 1.0, "moon_correction": False},
        "motor": {**DEFAULT_MOTOR, "speed_channel": 469, "direction_channel": 470},
    }
    config.update(overrides)
    return config


def longn_config(**overrides):
    """The LongN installation: 152 LEDs x 5 units, U0 + U1 per controller, LongN hardware defaults."""
    config = {
        "source_ip": None, "fps": 40, "rpm": 500, "pixels": 152, "unit_count": 5,
        "targets": [{"unit_id": unit_id, "ip": f"127.0.0.{unit_id}", "universes": [0, 1]} for unit_id in range(1, 6)],
        "hardware": dict(DEFAULT_HARDWARE),
        "motor": dict(DEFAULT_MOTOR),
    }
    config.update(overrides)
    return config
