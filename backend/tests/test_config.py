import json
from pathlib import Path
import tempfile
import unittest

from moon_observe_backend.config import DEFAULT_HARDWARE, DEFAULT_MOTOR, load_config
from moon_observe_backend.effects import default_preset

BACKEND = Path(__file__).resolve().parents[1]
TARGET = '[[artnet.targets]]\nunit_id = 1\nip = "2.0.0.101"\nuniverses = [0, 1]\n'
RENDER = '[render]\npreset = "preset.json"\n'


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "preset.json").write_text(json.dumps(default_preset("random-leds")), encoding="utf-8")

    def tearDown(self):
        self.directory.cleanup()

    def load(self, text):
        path = self.root / "config.toml"
        path.write_text(text, encoding="utf-8")
        return load_config(path)[0]

    def assertRejected(self, text, message):
        with self.assertRaisesRegex(ValueError, message):
            self.load(text)

    def test_shipped_example_is_the_longn_installation(self):
        config, preset = load_config(BACKEND / "config.example.toml")
        self.assertEqual([1, 2, 3, 4, 5], [target["unit_id"] for target in config["targets"]])
        self.assertEqual([f"2.0.0.10{unit}" for unit in range(1, 6)], [target["ip"] for target in config["targets"]])
        self.assertTrue(all(target["universes"] == [0, 1] for target in config["targets"]))
        self.assertEqual((152, 5, 40), (config["pixels"], config["unit_count"], config["fps"]))
        self.assertEqual(DEFAULT_HARDWARE, config["hardware"])
        self.assertEqual(DEFAULT_MOTOR, config["motor"])
        self.assertEqual(500, config["rpm"])
        self.assertEqual("random-leds", preset["effectId"])

    def test_omitted_sections_use_longn_defaults(self):
        config = self.load('[artnet]\nip = "2.0.0.101"\n' + RENDER)
        self.assertEqual(DEFAULT_HARDWARE, config["hardware"])
        self.assertEqual(DEFAULT_MOTOR, config["motor"])
        self.assertEqual((152, 5), (config["pixels"], config["unit_count"]))
        self.assertEqual([{"unit_id": 1, "ip": "2.0.0.101", "universes": [0]}], config["targets"])

    def test_partial_sections_override_single_fields(self):
        config = self.load(
            '[artnet]\n' + TARGET + RENDER
            + '[hardware]\nbrightness = 1\nmoon_correction = false\n'
            + '[motor]\nspeeds = { stop = 0, mid = 100, max = 255 }\nrpm = { mid = 200, max = 600 }\n'
        )
        self.assertEqual({"color_order": "GRB", "brightness": 1.0, "moon_correction": False}, config["hardware"])
        self.assertEqual({"stop": 0, "mid": 100, "max": 255}, config["motor"]["speeds"])
        self.assertEqual((457, 458), (config["motor"]["speed_channel"], config["motor"]["direction_channel"]))
        self.assertEqual(600, config["rpm"])

    def test_motor_channels_can_move_to_fit_more_pixels(self):
        config = self.load(
            '[artnet]\n' + TARGET + RENDER.replace("\n", "\npixels = 170\n", 1)
            + '[motor]\nspeed_channel = 511\ndirection_channel = 512\n'
        )
        self.assertEqual(170, config["pixels"])

    def test_universe_rules(self):
        self.assertRejected('[artnet]\nip = "2.0.0.101"\nuniverse = 0\nuniverses = [0]\n' + RENDER, "not both")
        self.assertRejected('[artnet]\nip = "2.0.0.101"\nuniverses = []\n' + RENDER, "1..4 universes")
        self.assertRejected('[artnet]\nip = "2.0.0.101"\nuniverses = [1, 1]\n' + RENDER, "must not repeat")
        self.assertRejected('[artnet]\nip = "2.0.0.101"\nuniverses = [32768]\n' + RENDER, "universes\\[0\\]")
        self.assertRejected('[artnet]\n[[artnet.targets]]\nunit_id = 1\nip = "2.0.0.101"\n' + RENDER, "universe or universes")
        self.assertRejected(
            '[artnet]\n' + TARGET + TARGET.replace("unit_id = 1", "unit_id = 2").replace("[0, 1]", "[1, 2]") + RENDER,
            "pairs must be unique",
        )
        self.assertRejected('[artnet]\nip = "2.0.0.101"\n' + TARGET + RENDER, "must replace ip/universe")

    def test_render_rules(self):
        self.assertRejected('[artnet]\n' + TARGET + RENDER + 'rpm = 360\n', "unknown config field")
        self.assertRejected('[artnet]\n' + TARGET + RENDER + 'pixels = 153\n', "overlap")
        self.assertRejected('[artnet]\n' + TARGET + RENDER + 'pixels = 171\n', "render.pixels")
        self.assertRejected('[artnet]\n' + TARGET.replace("unit_id = 1", "unit_id = 6") + RENDER, "unit_id")

    def test_hardware_rules(self):
        base = '[artnet]\n' + TARGET + RENDER
        self.assertRejected(base + '[hardware]\ncolor_order = "RGBW"\n', "color_order")
        self.assertRejected(base + '[hardware]\nbrightness = 1.5\n', "brightness")
        self.assertRejected(base + '[hardware]\nbrightness = true\n', "brightness")
        self.assertRejected(base + '[hardware]\nmoon_correction = 1\n', "moon_correction")
        self.assertRejected(base + '[hardware]\ngamma = 2.2\n', "unknown hardware config field")
        self.assertRejected(base + '[extra]\nvalue = 1\n', "optional: \\[hardware\\]")

    def test_motor_rules(self):
        base = '[artnet]\n' + TARGET + RENDER
        self.assertRejected(base + '[motor]\nspeed_channel = 458\n', "must differ")
        self.assertRejected(base + '[motor]\nspeed_channel = 0\n', "motor.speed_channel")
        self.assertRejected(base + '[motor]\nspeed_channel = 400\n', "overlap")
        self.assertRejected(base + '[motor]\nspeeds = { stop = 0, max = 230 }\n', "exactly stop, mid, max")
        self.assertRejected(base + '[motor]\nspeeds = { stop = 0, mid = 60, max = 256 }\n', "motor.speeds.max")
        self.assertRejected(base + '[motor]\ndirections = { cw = 0, ccw = 255, left = 1 }\n', "exactly cw, ccw")
        self.assertRejected(base + '[motor]\nrpm = { mid = 130, max = 10001 }\n', "motor.rpm.max")
        self.assertRejected(base + '[motor]\nacceleration = 1\n', "unknown motor config field")


if __name__ == "__main__":
    unittest.main()
