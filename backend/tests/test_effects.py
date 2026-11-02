import hashlib
import json
import unittest
from pathlib import Path

from moon_observe_backend.effects import EffectContext, axis_change_weight, completion_frames, default_preset, preset_for_unit, preset_to_json, sample_effect, unit_palette_position, validate_preset
from moon_observe_backend.renderer import render_frame, rgb_bytes

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "effects_v2.json"


class EffectParityTests(unittest.TestCase):
    def test_world_upper_third_gates_full_half_strip_by_phase(self) -> None:
        preset = validate_preset(default_preset("world-upper-half"))

        def lit_indices(projection: float) -> list[int]:
            return [index for index in range(156) if any(sample_effect(
                preset,
                EffectContext(0, 40, index, 156, unit_phase_projection=projection),
            ))]

        self.assertEqual([], lit_indices(0.5))
        self.assertEqual(list(range(78)), lit_indices(0.51))
        self.assertEqual(list(range(78, 156)), lit_indices(-0.51))
        self.assertEqual([], lit_indices(0))

        unit = {"unitId": 1, "logicalPixelCount": 156, "frameOffset": 0,
                "virtualPhaseRadians": -1.5707963267948966}
        self.assertEqual(78, sum(any(pixel) for pixel in render_frame(preset, unit, 0)))

        def brightness(index: int) -> float:
            return sample_effect(preset, EffectContext(0, 40, index, 156))[0]

        self.assertEqual(1.0, brightness(0))
        self.assertEqual(1.0, brightness(50))
        self.assertGreater(brightness(65), brightness(72))
        self.assertGreater(brightness(72), brightness(77))
        self.assertGreater(brightness(77), 0)
        self.assertEqual(0, brightness(78))

    def test_frontend_golden_vectors(self) -> None:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
        presets = [validate_preset(preset) for preset in fixture["presets"]]
        self.assertEqual(20, len({preset["effectId"] for preset in presets}))
        self.assertEqual(720, len(fixture["samples"]))
        for sample in fixture["samples"]:
            data = sample["context"]
            context = EffectContext(
                controller_frame=data["controllerFrame"],
                controller_fps=fixture["controllerFps"],
                led_index=data["ledIndex"],
                led_count=fixture["ledCount"],
                unit_index=data["unitIndex"],
                unit_count=9,
                global_controller_frame=data["globalControllerFrame"],
                unit_relative_y=data["unitRelativeY"],
                unit_phase_projection=data["unitPhaseProjection"],
            )
            actual = sample_effect(presets[sample["presetIndex"]], context)
            for channel, value in zip(("r", "g", "b"), actual):
                self.assertAlmostEqual(
                    sample["expected"][channel], value, places=10,
                    msg=f"{presets[sample['presetIndex']]['effectId']} {data} {channel}",
                )

    def test_frontend_full_frame_bytes(self) -> None:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
        presets = [validate_preset(preset) for preset in fixture["presets"]]
        self.assertEqual(1440, len(fixture["frames"]))
        for case in fixture["frames"]:
            preset = presets[case["presetIndex"]]
            pixels = [
                sample_effect(
                    preset,
                    EffectContext(
                        controller_frame=case["controllerFrame"],
                        controller_fps=40,
                        led_index=led_index,
                        led_count=156,
                        unit_index=case["unitIndex"],
                        unit_count=9,
                        global_controller_frame=case["globalFrame"],
                        unit_relative_y=(led_index - 77.5) / 77.5,
                    ),
                )
                for led_index in range(156)
            ]
            digest = hashlib.sha256(rgb_bytes(pixels)).hexdigest()
            self.assertEqual(case["sha256"], digest, msg=str(case))
    def test_preset_rejects_invalid_color_and_parameter(self) -> None:
        preset = default_preset("periodic-leds")
        preset["parameters"]["darkGap"] = 155
        with self.assertRaises(ValueError):
            validate_preset(preset)

        preset = default_preset("random-leds")
        preset["parameters"].update({"holdFrames": 2, "minHoldFrames": 3})
        with self.assertRaises(ValueError):
            validate_preset(preset)
        preset = default_preset("center-out-sine")
        preset["color"] = {"mode": "gradient", "axis": "strip", "colors": [{"r": 1, "g": 0, "b": 0}]}
        with self.assertRaises(ValueError):
            validate_preset(preset)
        preset = default_preset("center-out-sine")
        preset["color"] = {"mode": "solid", "color": {"r": float("nan"), "g": 0, "b": 0}}
        with self.assertRaises(ValueError):
            validate_preset(preset)

    def test_random_leds_distance_duration_and_equal_mode(self) -> None:
        preset = default_preset("random-leds")
        preset["parameters"].update({
            "litCount": 156, "holdFrames": 8, "durationMode": 1, "minHoldFrames": 1,
        })
        normalized = validate_preset(preset)

        def lit(frame: int, index: int) -> bool:
            return any(sample_effect(normalized, EffectContext(frame, 40, index, 156)))

        self.assertTrue(lit(0, 0))
        self.assertFalse(lit(1, 0))
        self.assertTrue(lit(7, 77))
        self.assertTrue(lit(8, 0))

        normalized["parameters"]["durationMode"] = 0
        self.assertTrue(lit(7, 0))

    def test_single_unit_rgb_frame(self) -> None:
        preset = validate_preset(default_preset("random-leds"))
        frame = render_frame(preset, {"unitId": 1, "logicalPixelCount": 156, "frameOffset": 0}, 4)
        self.assertEqual(156, len(frame))
        self.assertEqual(468, len(rgb_bytes(frame)))
        self.assertEqual(12, sum(any(channel > 0 for channel in pixel) for pixel in frame))

    def test_sine_swell_cycle_and_depth_limits(self) -> None:
        preset = validate_preset(default_preset("sine-swell"))
        # Matches the frontend completion: ceil(40 FPS / 0.3 Hz).
        self.assertEqual(134, completion_frames(preset, 40, 9))
        preset = default_preset("sine-swell")
        preset["parameters"]["depth"] = 0.05
        with self.assertRaises(ValueError):
            validate_preset(preset)

    def test_reverse_tide_cycle_is_whole_frames_and_seamless(self) -> None:
        for speed_hz, hold_seconds in ((0.25, 0.5), (0.3, 0.7), (0.05, 0), (1, 3), (0.35, 1.3)):
            preset = default_preset("reverse-tide")
            preset["parameters"].update({"speedHz": speed_hz, "holdSeconds": hold_seconds})
            normalized = validate_preset(preset)
            cycle = completion_frames(normalized, 40, 9)

            def strip(frame: int) -> list:
                return [sample_effect(normalized, EffectContext(frame, 40, index, 101)) for index in range(101)]

            # 一輪結尾與下一輪開頭相同 / The next cycle starts exactly like the first.
            self.assertEqual(strip(0), strip(cycle))
            if hold_seconds > 0:
                self.assertEqual(0, max(max(pixel) for pixel in strip(cycle - 1)))
        self.assertEqual(292, completion_frames(validate_preset(default_preset("reverse-tide")), 40, 9))

    def test_unit_axis_gives_each_unit_one_solid_color(self) -> None:
        preset = default_preset("color-breathing")
        preset["color"] = {"mode": "gradient", "axis": "unit",
                           "colors": [{"r": 1, "g": 0, "b": 0}, {"r": 0, "g": 0, "b": 1}]}
        normalized = validate_preset(preset)

        def unit_frame(unit_id: int, **kwargs) -> list:
            # Frame 0 of color-breathing is full brightness on every LED.
            return render_frame(normalized, {"unitId": unit_id, "logicalPixelCount": 12, "frameOffset": 0}, 0, **kwargs)

        expected = [(1 - i / 8, 0.0, i / 8) for i in range(9)]
        for unit_id in range(1, 10):
            frame = unit_frame(unit_id)
            self.assertEqual(1, len(set(frame)))
            for actual, wanted in zip(frame[0], expected[unit_id - 1]):
                self.assertAlmostEqual(wanted, actual)
        self.assertEqual({(1.0, 0.0, 0.0)}, set(unit_frame(1, unit_count=1)))

        # Weather colors keep the effect's per-unit choice; other axes follow the palette.
        weather = {"axis": "radius", "colors": [{"r": 0, "g": 1, "b": 0}, {"r": 1, "g": 1, "b": 1}]}
        self.assertEqual({(1.0, 1.0, 1.0)}, set(unit_frame(9, color_override=weather)))
        normalized["color"] = {**normalized["color"], "axis": "strip"}
        self.assertEqual(2, len(set(unit_frame(9, color_override=weather)[:2])))

        preset["color"]["axis"] = "diagonal"
        with self.assertRaises(ValueError):
            validate_preset(preset)

    def test_random_fill_accelerates_and_skips_palette_colors(self):
        preset = validate_preset(default_preset("random-fill"))
        self.assertEqual(68 * 40, completion_frames(preset, 40, 9))

        def lit(frame: int, unit: int = 0) -> int:
            return sum(any(sample_effect(preset, EffectContext(frame, 40, led, 156, unit, 9))) for led in range(156))

        # Dark at the start; 156 * (t / 60 s)^2 LEDs lit, so the second half lights far more than the first.
        self.assertEqual((0, 0, 1), (lit(0), lit(191), lit(192)))
        self.assertEqual((39, 156), (lit(30 * 40), lit(60 * 40)))
        self.assertEqual(0, lit(68 * 40 - 1))
        self.assertEqual(0, lit(68 * 40))

        self.assertEqual([0, 4, 8, 3, 7, 2, 6, 1, 5], [round(unit_palette_position(unit, 9) * 8) for unit in range(9)])
        self.assertEqual(0.0, unit_palette_position(0, 1))
        unit = {"unitId": 2, "logicalPixelCount": 156, "frameOffset": 0}
        weather = {"axis": "radius", "colors": [{"r": 1, "g": 0, "b": 0}, {"r": 0, "g": 0, "b": 1}]}
        # Unit 2 sits at palette position 4/8 on any axis, including the weather palette's.
        self.assertEqual({(0.5, 0.0, 0.5)}, set(render_frame(preset, unit, 61 * 40, color_override=weather)))

    def test_weather_palette_opt_out_keeps_own_colors(self):
        preset = default_preset("color-breathing")
        preset["color"] = {"mode": "solid", "color": {"r": 1, "g": 0, "b": 0}, "weatherPalette": False}
        normalized = validate_preset(preset)
        self.assertIs(False, normalized["color"]["weatherPalette"])
        self.assertEqual(preset["color"], preset_to_json(normalized)["color"])
        weather = {"axis": "radius", "colors": [{"r": 0, "g": 1, "b": 0}, {"r": 1, "g": 1, "b": 1}]}
        unit = {"unitId": 1, "logicalPixelCount": 12, "frameOffset": 0}
        self.assertEqual({(1.0, 0.0, 0.0)}, set(render_frame(normalized, unit, 0, color_override=weather)))

        # true is the default and is not written back; anything else is rejected.
        preset["color"]["weatherPalette"] = True
        normalized = validate_preset(preset)
        self.assertNotIn("weatherPalette", preset_to_json(normalized)["color"])
        self.assertNotIn((1.0, 0.0, 0.0), set(render_frame(normalized, unit, 0, color_override=weather)))
        preset["color"]["weatherPalette"] = 0
        with self.assertRaises(ValueError):
            validate_preset(preset)

    def test_frontend_unit_variation_values_and_cycles(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
        self.assertEqual(81, len(fixture["unitVariations"]))
        for case in fixture["unitVariations"]:
            preset = validate_preset(case["preset"])
            self.assertEqual(case["preset"], preset_to_json(preset))
            key = case["preset"]["unitVariation"]["parameter"]
            values = [preset_for_unit(preset, unit, 9)["parameters"][key] for unit in range(9)]
            self.assertEqual(case["values"], values, msg=f"{preset['effectId']} {case['preset']['unitVariation']}")
            self.assertEqual(case["completionFrames"], completion_frames(preset, 40, 9))

    def test_unit_variation_renders_each_unit_with_its_own_value(self):
        preset = default_preset("sine-swell")
        preset["unitVariation"] = {"parameter": "depth", "from": 0.1, "to": 1, "distribution": "linear"}
        normalized = validate_preset(preset)
        self.assertNotIn("unitVariation", preset_for_unit(normalized, 0, 9))

        def darkest(unit_id: int) -> float:
            unit = {"unitId": unit_id, "logicalPixelCount": 156, "frameOffset": 0}
            return min(pixel[0] for pixel in render_frame(normalized, unit, 0))

        # Trough brightness is 1 - depth: unit 1 keeps 0.9, unit 9 goes dark.
        self.assertAlmostEqual(0.9, darkest(1), places=3)
        self.assertLess(darkest(9), 0.01)

        # Count wrap follows each unit's own cycle: unit 9 (2 Hz) repeats after 20 frames, unit 1 does not.
        speed = default_preset("sine-swell")
        speed["unitVariation"] = {"parameter": "speedHz", "from": 0.2, "to": 2, "distribution": "linear"}
        speed = validate_preset(speed)
        self.assertEqual(200, completion_frames(speed, 40, 9))
        for unit_id, same in ((9, True), (1, False)):
            unit = {"unitId": unit_id, "logicalPixelCount": 156, "frameOffset": 0}
            first = render_frame(speed, unit, 0, cycle_frames=200)
            self.assertEqual(same, first == render_frame(speed, unit, 20, cycle_frames=200))

    def test_unit_variation_rejects_invalid_settings(self):
        for effect_id, variation in (
            ("sine-swell", {"parameter": "depth", "from": 0.1, "to": 1}),
            ("sine-swell", {"parameter": "depth", "from": 0.1, "to": 1, "distribution": "wave"}),
            ("sine-swell", {"parameter": "depth", "from": 0.1, "to": 2, "distribution": "linear"}),
            ("sine-swell", {"parameter": "litCount", "from": 1, "to": 2, "distribution": "linear"}),
            ("sequential-center-fill", {"parameter": "holdSeconds", "from": 0, "to": 1, "distribution": "linear"}),
            ("random-leds", {"parameter": "durationMode", "from": 0, "to": 1, "distribution": "linear"}),
        ):
            preset = default_preset(effect_id)
            preset["unitVariation"] = variation
            with self.assertRaises(ValueError, msg=f"{effect_id} {variation}"):
                validate_preset(preset)


    def test_frontend_axis_change_samples(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
        self.assertEqual(6, len(fixture["axisChanges"]))
        for case in fixture["axisChanges"]:
            preset = validate_preset(case["preset"])
            self.assertEqual(case["preset"], preset_to_json(preset))
            for sample in case["samples"]:
                frame = sample["elapsedFrame"]
                context = EffectContext(
                    controller_frame=frame + sample["unitIndex"] * 2, controller_fps=40,
                    led_index=sample["ledIndex"], led_count=156, unit_index=sample["unitIndex"], unit_count=9,
                    global_controller_frame=frame, unit_relative_y=0.3,
                )
                actual = sample_effect(preset, context, frame)
                for channel, value in zip(("r", "g", "b"), actual):
                    self.assertAlmostEqual(sample["expected"][channel], value, places=10,
                                           msg=f"{preset['effectId']} {sample} {channel}")

    def test_axis_change_weight_once_and_repeat(self):
        once = {"to": "unit", "atSeconds": 2, "blendSeconds": 1, "repeat": False}
        self.assertEqual([0, 0, 0.5, 1, 1], [axis_change_weight(once, f, 40) for f in (0, 80, 100, 120, 10_000)])
        repeat = {**once, "repeat": True}
        self.assertEqual([0, 0, 0.5, 1, 1, 0.5, 0, 0, 0.5],
                         [axis_change_weight(repeat, f, 40) for f in (0, 79, 100, 120, 199, 220, 240, 319, 340)])

    def test_axis_change_follows_step_time_under_weather(self):
        # The weather palette keeps the effect's own axis and its axis change; render_frame times it from step start.
        preset = default_preset("full-on")
        preset["color"] = {"mode": "gradient", "axis": "strip", "colors": [{"r": 1, "g": 1, "b": 1}, {"r": 1, "g": 1, "b": 1}],
                           "axisChange": {"to": "radius", "atSeconds": 1, "blendSeconds": 0, "repeat": False}}
        normalized = validate_preset(preset)
        weather = {"axis": "unit", "colors": [{"r": 1, "g": 0, "b": 0}, {"r": 0, "g": 0, "b": 1}]}
        unit = {"unitId": 1, "logicalPixelCount": 5, "frameOffset": 7}
        strip = [(1.0, 0.0, 0.0), (0.75, 0.0, 0.25), (0.5, 0.0, 0.5), (0.25, 0.0, 0.75), (0.0, 0.0, 1.0)]
        radius = [(0.0, 0.0, 1.0), (0.5, 0.0, 0.5), (1.0, 0.0, 0.0), (0.5, 0.0, 0.5), (0.0, 0.0, 1.0)]
        self.assertEqual(strip, render_frame(normalized, unit, 39, color_override=weather))
        self.assertEqual(radius, render_frame(normalized, unit, 40, color_override=weather))
        # Solid effects take the palette's axis (here one color per unit: unit 1 is the first stop).
        solid = validate_preset(default_preset("full-on"))
        self.assertEqual({(1.0, 0.0, 0.0)}, set(render_frame(solid, unit, 0, color_override=weather)))

    def test_axis_change_rejects_invalid_settings(self):
        base = {"to": "radius", "atSeconds": 1, "blendSeconds": 0.5, "repeat": False}
        for change in ({**base, "to": "diagonal"}, {**base, "atSeconds": -1}, {**base, "blendSeconds": "1"},
                       {**base, "repeat": 1}, {**base, "extra": 1}, {"to": "radius"}, [], {**base, "atSeconds": float("nan")}):
            preset = default_preset("full-on")
            preset["color"] = {"mode": "gradient", "axis": "strip", "colors": [{"r": 1, "g": 1, "b": 1}] * 2, "axisChange": change}
            with self.assertRaises(ValueError, msg=str(change)):
                validate_preset(preset)
        preset = default_preset("full-on")
        preset["color"]["axisChange"] = base
        with self.assertRaises(ValueError):
            validate_preset(preset)


if __name__ == "__main__":
    unittest.main()


class UnitEffectTests(unittest.TestCase):
    def test_frontend_unit_effect_hashes(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
        self.assertEqual(6, len(fixture["unitEffects"]))
        for case in fixture["unitEffects"]:
            preset = validate_preset(case["preset"])
            unit_count = case["unitCount"]
            self.assertEqual(case["totalFrames"], 2 * completion_frames(preset, 40, unit_count))
            data = bytearray()
            for frame in range(case["totalFrames"]):
                for unit_index in range(unit_count):
                    for led_index in case["leds"]:
                        data.extend(rgb_bytes([sample_effect(preset, EffectContext(
                            frame, 40, led_index, 156, unit_index, unit_count, global_controller_frame=frame,
                        ))]))
            self.assertEqual(case["sha256"], hashlib.sha256(bytes(data)).hexdigest(),
                             f"{preset['effectId']} x{unit_count}")

    def test_unit_effects_ignore_weather_timing(self):
        for effect_id in ("unit-chase", "unit-random", "roulette-ring"):
            preset = validate_preset(default_preset(effect_id))
            plain = {"unitId": 6, "logicalPixelCount": 156, "frameOffset": 0}
            cloudy = {**plain, "frameOffset": 30}
            for frame in (0, 5, 37, 300):
                expected = render_frame(preset, plain, frame)
                self.assertEqual(expected, render_frame(preset, cloudy, frame), effect_id)
                self.assertEqual(expected, render_frame(preset, cloudy, frame, raining=True), effect_id)
        # 其他效果仍受影響。 / Other effects still follow the weather.
        full_on = validate_preset(default_preset("full-on"))
        unit = {"unitId": 6, "logicalPixelCount": 156, "frameOffset": 0}
        self.assertNotEqual(render_frame(full_on, unit, 0), render_frame(full_on, unit, 0, raining=True))

    def test_rain_lines_match_frontend(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))["rainLines"]
        frames = [frame for start, end in fixture["frameRanges"] for frame in range(start, end)]
        self.assertEqual(40, len(fixture["cases"]))
        for case in fixture["cases"]:
            preset = validate_preset(default_preset(case["effectId"]))
            data = bytearray()
            for frame in frames:
                for unit_index in fixture["units"]:
                    data.extend(rgb_bytes([
                        sample_effect(preset, EffectContext(
                            frame, case["fps"], led_index, 156, unit_index, 9, global_controller_frame=frame,
                        ), frame, True)
                        for led_index in range(156)
                    ]))
            self.assertEqual(case["sha256"], hashlib.sha256(bytes(data)).hexdigest(),
                             f"{case['effectId']} {case['fps']} fps")

    def test_rain_keeps_effects_without_rain_lines(self):
        for effect_id in ("random-leds", "twenty-beat", "spectrum-cycle", "moving-rings", "periodic-leds",
                          "world-upper-half", "sector-smear"):
            preset = validate_preset(default_preset(effect_id))
            unit = {"unitId": 3, "logicalPixelCount": 156, "frameOffset": 4}
            for frame in (0, 17, 333):
                self.assertEqual(render_frame(preset, unit, frame), render_frame(preset, unit, frame, raining=True), effect_id)

    def test_rain_full_on_is_streaks_of_the_sparse_density(self):
        full_on = validate_preset(default_preset("full-on"))
        unit = {"unitId": 1, "logicalPixelCount": 156, "frameOffset": 0}
        lit = [sum(1 for pixel in render_frame(full_on, unit, frame, raining=True) if pixel != (0.0, 0.0, 0.0))
               for frame in range(0, 400, 2)]
        self.assertAlmostEqual(0.18, sum(lit) / (len(lit) * 156), delta=0.02)

    def test_unit_effects_reject_unit_variation(self):
        for effect_id in ("unit-chase", "unit-random", "roulette-ring"):
            preset = default_preset(effect_id)
            parameter = next(iter(preset["parameters"]))
            preset["unitVariation"] = {"parameter": parameter, "from": preset["parameters"][parameter],
                                       "to": preset["parameters"][parameter], "distribution": "linear"}
            with self.assertRaises(ValueError, msg=effect_id):
                validate_preset(preset)
