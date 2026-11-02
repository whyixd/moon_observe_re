import random
import unittest

from moon_observe_backend.config import DEFAULT_HARDWARE, DEFAULT_MOTOR
from moon_observe_backend.hardware import (
    PACKET_SIZE, apply_moon_correction, blackout_payload, build_payload, led_bytes, moon_correction_gain,
)

LONGN_LED_NUM = 76
LONGN_TURNING_MODE = {"stop": 0, "mid": 1, "max": 2}
LONGN_MAX_DMX_SPEED = 230
LONGN_MID_DMX_SPEED = 60


def longn_processing_round(value: float) -> int:
    # Processing PApplet.round(float) = (int) Math.round(value) = floor(value + 0.5).
    return int(value + 0.5) if value >= 0 else -int(-value + 0.5)


def longn_lerp_to_black(color: int, amount: float) -> int:
    """Processing lerpColor(color(0), color, amount) in RGB mode (alpha included)."""
    channels = [(color >> shift) & 0xFF for shift in (24, 16, 8, 0)]
    black = [0xFF, 0, 0, 0]  # color(0) is opaque black.
    a, r, g, b = (longn_processing_round(low + (high - low) * amount) for low, high in zip(black, channels))
    return (a << 24) | (r << 16) | (g << 8) | b


def longn_moon_correction(led_color: list[int], turning_mode: int) -> list[int]:
    """LongN/Video.pde:121-132 for one unit. led_color[k] holds video row j = 75 - k."""
    result = list(led_color)
    if turning_mode != 2:
        return result
    outter, inner = 15, 7
    for j in range(LONGN_LED_NUM):
        k = LONGN_LED_NUM - j - 1
        if j >= LONGN_LED_NUM - outter:
            result[k] = longn_lerp_to_black(result[k], (LONGN_LED_NUM - j) / outter)
        elif j < inner:
            result[k] = longn_lerp_to_black(result[k], 0.3 + (1 - 0.3) * (j / inner))
    return result


def longn_send_artnet(led_color: list[int], turning_mode: int, is_clockwise: bool, dim: int) -> bytes:
    """Line-for-line port of LongN/Artnet.pde:14-97 for one target with isRGB == false (GRB)."""
    data = [0] * 512
    index = 0
    for order in (range(LONGN_LED_NUM), reversed(range(LONGN_LED_NUM))):  # forward, then "for NCTU"
        for k in order:
            color = led_color[k]
            for shift in (8, 16, 0):  # G, R, B
                data[index] = ((color >> shift) & 0xFF) * dim // 100
                index += 1
    data[index] = LONGN_MAX_DMX_SPEED if turning_mode == 2 else LONGN_MID_DMX_SPEED if turning_mode == 1 else 0
    index += 1
    data[index] = 0 if is_clockwise else 255
    return bytes(data)


def to_pixels(led_color: list[int]) -> list[tuple[float, float, float]]:
    """LongN's 76 colours laid out on the 152-pixel strip (index 0 = LongN led 0)."""
    def rgb(color):
        return (((color >> 16) & 0xFF) / 255, ((color >> 8) & 0xFF) / 255, (color & 0xFF) / 255)
    half = [rgb(color) for color in led_color]
    return half + half[::-1]


def random_led_color(rng: random.Random) -> list[int]:
    return [0xFF000000 | rng.randrange(1 << 24) for _ in range(LONGN_LED_NUM)]


def payload(pixels, *, speed="stop", direction="cw", moon=False, brightness=None, color_order=None):
    hardware = {**DEFAULT_HARDWARE}
    if brightness is not None:
        hardware["brightness"] = brightness
    if color_order is not None:
        hardware["color_order"] = color_order
    return build_payload(pixels, hardware=hardware, motor=DEFAULT_MOTOR, speed=speed,
                         direction=direction, moon_correction=moon)


class LongNGoldenTests(unittest.TestCase):
    def test_channel_layout_matches_longn_byte_for_byte(self):
        rng = random.Random(20261102)
        for speed, mode in LONGN_TURNING_MODE.items():
            for direction in ("cw", "ccw"):
                led_color = random_led_color(rng)
                expected = longn_send_artnet(led_color, mode, direction == "cw", dim=100)
                actual = payload(to_pixels(led_color), speed=speed, direction=direction, brightness=1.0)
                self.assertEqual(expected, actual, (speed, direction))

    def test_brightness_and_moon_correction_stay_within_one_step_of_longn(self):
        # LongN rounds after lerpColor and truncates after *DIM/100; we scale in floating point and
        # round once, so a channel can only come out 0 or 1 step brighter than LongN.
        rng = random.Random(7)
        for _ in range(40):
            for speed, mode in LONGN_TURNING_MODE.items():
                led_color = random_led_color(rng)
                expected = longn_send_artnet(longn_moon_correction(led_color, mode), mode, True, dim=40)
                actual = payload(to_pixels(led_color), speed=speed, moon=True, brightness=0.4)
                differences = {a - e for a, e in zip(actual, expected)}
                self.assertLessEqual(differences, {0, 1}, speed)

    def test_moon_correction_gains_match_longn_formula(self):
        for k in range(LONGN_LED_NUM):
            j = LONGN_LED_NUM - k - 1
            if j >= LONGN_LED_NUM - 15:
                expected = (LONGN_LED_NUM - j) / 15
            elif j < 7:
                expected = 0.3 + 0.7 * (j / 7)
            else:
                expected = 1.0
            self.assertAlmostEqual(expected, moon_correction_gain(k, 152), places=12, msg=k)
            self.assertAlmostEqual(expected, moon_correction_gain(151 - k, 152), places=12, msg=k)


class HardwareTests(unittest.TestCase):
    def test_moon_correction_shape(self):
        gains = [moon_correction_gain(index, 152) for index in range(152)]
        self.assertEqual(gains, gains[::-1])
        self.assertAlmostEqual(1 / 15, gains[0])
        self.assertEqual(1.0, gains[14])
        self.assertEqual([1.0] * (69 - 15), gains[15:69])
        self.assertAlmostEqual(0.3, gains[75])
        self.assertAlmostEqual(0.3, gains[76])
        self.assertAlmostEqual(1 / 15, moon_correction_gain(0, 1))  # degenerate strip: the foot fade wins
        with self.assertRaises(ValueError):
            moon_correction_gain(152, 152)

    def test_moon_correction_only_at_max_speed(self):
        white = [(1.0, 1.0, 1.0)] * 152
        plain = payload(white, speed="mid", moon=True, brightness=1.0)
        self.assertEqual(bytes([255]) * 456, plain[:456])
        corrected = payload(white, speed="max", moon=True, brightness=1.0)
        self.assertEqual(bytes([17, 17, 17]), corrected[:3])  # round(255 / 15)
        self.assertEqual(bytes([77, 77, 77]), corrected[75 * 3:76 * 3])  # round(255 * 0.3)
        self.assertEqual(payload(white, speed="max", moon=False, brightness=1.0)[:456], plain[:456])
        self.assertEqual(apply_moon_correction(white)[20], (1.0, 1.0, 1.0))

    def test_color_order_and_brightness_rounding(self):
        pixel = [(1.0, 0.5, 0.0)]
        self.assertEqual(bytes([255, 128, 0]), led_bytes(pixel, "RGB", 1.0))
        self.assertEqual(bytes([128, 255, 0]), led_bytes(pixel, "GRB", 1.0))
        self.assertEqual(bytes([0, 128, 255]), led_bytes(pixel, "BGR", 1.0))
        self.assertEqual(bytes([51, 102, 0]), led_bytes(pixel, "GRB", 0.4))  # floor(x * 255 + 0.5)
        self.assertEqual(bytes([255, 0, 0]), led_bytes([(2.0, -1.0, 0.0)], "RGB", 1.0))
        with self.assertRaises(ValueError):
            led_bytes(pixel, "RGBW", 1.0)
        with self.assertRaises(ValueError):
            led_bytes(pixel, "RGB", 1.5)

    def test_payload_motor_channels_and_padding(self):
        frame = payload([(0.0, 0.0, 0.0)] * 152, speed="max", direction="ccw")
        self.assertEqual(PACKET_SIZE, len(frame))
        self.assertEqual(230, frame[456])  # channel 457
        self.assertEqual(255, frame[457])  # channel 458
        self.assertEqual(bytes(PACKET_SIZE - 458), frame[458:])
        self.assertEqual((60, 0), tuple(payload([], speed="mid", direction="cw")[456:458]))
        self.assertEqual(bytes(PACKET_SIZE), blackout_payload())

    def test_payload_rejects_bad_levels_and_overlap(self):
        with self.assertRaisesRegex(ValueError, "speed"):
            payload([], speed="fast")
        with self.assertRaisesRegex(ValueError, "direction"):
            payload([], direction="left")
        with self.assertRaisesRegex(ValueError, "overlap"):
            payload([(0.0, 0.0, 0.0)] * 153)


if __name__ == "__main__":
    unittest.main()
