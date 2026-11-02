"""LongN hardware mapping: one 512-byte DMX frame per unit (LEDs + motor speed/direction).

Pure functions only (no sockets, no state). The layout follows the original Processing sketch
(``LongN/Artnet.pde``): pixel channels first, then the motor speed and direction channels, the
rest zero. The same frame is sent to every universe of a target (U0 drives DMX/motor and U1
drives the SPI pixels on the LongN controller box).

LongN 硬體對應：每台一包 512 bytes（LED + 馬達速度／方向），只有純函式。
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

from .effects import Rgb, clamp01

PACKET_SIZE = 512  # Full DMX universe, as LongN sent; even length as ArtDmx requires.
CHANNELS_PER_PIXEL = 3
MAX_PIXELS = PACKET_SIZE // CHANNELS_PER_PIXEL  # 170
COLOR_ORDERS = ("RGB", "RBG", "GRB", "GBR", "BRG", "BGR")
SPEED_LEVELS = ("stop", "mid", "max")
DIRECTIONS = ("cw", "ccw")

# 月亮校正（LongN Video.pde:122-132）：靠腳 15 顆線性漸暗、靠頂點 7 顆從 0.3 漸增到 1。
# Moon correction from LongN: the 15 pixels nearest each foot fade to black, the 7 nearest the apex
# rise from 0.3 to 1. Distances are counted from the nearer end, so both halves are symmetric.
FOOT_FADE_PIXELS = 15
APEX_FADE_PIXELS = 7
APEX_MIN_GAIN = 0.3


def moon_correction_gain(index: int, count: int) -> float:
    """Gain for pixel ``index`` of ``count`` (0 and count-1 are the feet, the middle is the apex)."""
    if not 0 <= index < count:
        raise ValueError("pixel index out of range")
    from_foot = min(index, count - 1 - index)
    from_apex = (count - 1) // 2 - from_foot
    if from_foot < FOOT_FADE_PIXELS:
        return (from_foot + 1) / FOOT_FADE_PIXELS
    if from_apex < APEX_FADE_PIXELS:
        return APEX_MIN_GAIN + (1 - APEX_MIN_GAIN) * from_apex / APEX_FADE_PIXELS
    return 1.0


def apply_moon_correction(pixels: Sequence[Rgb]) -> list[Rgb]:
    count = len(pixels)
    result = []
    for index, (r, g, b) in enumerate(pixels):
        gain = moon_correction_gain(index, count)
        result.append((r * gain, g * gain, b * gain))
    return result


def _channel_byte(value: float, brightness: float) -> int:
    # 與參考系統相同的捨入：floor(x + 0.5)，不是 Python 的銀行家捨入。
    return math.floor(clamp01(clamp01(value) * brightness) * 255 + 0.5)


def led_bytes(pixels: Sequence[Rgb], color_order: str, brightness: float) -> bytes:
    """Quantize RGB (0..1) pixels to bytes in the strip's colour order, scaled by brightness."""
    if color_order not in COLOR_ORDERS:
        raise ValueError(f"color order must be one of {', '.join(COLOR_ORDERS)}")
    if type(brightness) not in (int, float) or not math.isfinite(brightness) or not 0 <= brightness <= 1:
        raise ValueError("brightness must be between 0 and 1")
    order = tuple("RGB".index(channel) for channel in color_order)
    return bytes(_channel_byte(pixel[channel], brightness) for pixel in pixels for channel in order)


def build_payload(
    pixels: Sequence[Rgb],
    *,
    hardware: Mapping[str, Any],
    motor: Mapping[str, Any],
    speed: str,
    direction: str,
    moon_correction: bool,
) -> bytes:
    """One unit's 512-byte frame.

    ``hardware``/``motor`` are the validated config sections. Moon correction applies only while the
    unit runs at ``max`` speed, as in LongN (turnningMode == 2).
    """
    if speed not in SPEED_LEVELS:
        raise ValueError(f"speed must be one of {', '.join(SPEED_LEVELS)}")
    if direction not in DIRECTIONS:
        raise ValueError(f"direction must be one of {', '.join(DIRECTIONS)}")
    if moon_correction and speed == "max":
        pixels = apply_moon_correction(pixels)
    leds = led_bytes(pixels, hardware["color_order"], hardware["brightness"])
    speed_index = motor["speed_channel"] - 1
    direction_index = motor["direction_channel"] - 1
    if len(leds) > min(speed_index, direction_index):
        raise ValueError("pixel channels overlap the motor channels")
    payload = bytearray(PACKET_SIZE)
    payload[:len(leds)] = leds
    payload[speed_index] = motor["speeds"][speed]
    payload[direction_index] = motor["directions"][direction]
    return bytes(payload)


def blackout_payload() -> bytes:
    """All channels zero: LEDs off and motor stopped (LongN sendExit)."""
    return bytes(PACKET_SIZE)
