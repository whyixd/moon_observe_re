import json
import os
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from moon_observe_backend.config import DEFAULT_HARDWARE, DEFAULT_MOTOR
from moon_observe_backend.control import PresetStore, make_server
from moon_observe_backend.effects import default_preset, validate_preset
from moon_observe_backend.motor import HardwareStore, MotorStore
from moon_observe_backend.playback import PlaybackMonitor
from support import longn_config

CONFIG = longn_config()
STOPPED = [("stop", "cw")] * 5


class MotorStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = MotorStore(DEFAULT_MOTOR, 5)

    def test_starts_stopped_clockwise(self):
        self.assertEqual(tuple(STOPPED), self.store.snapshot())
        state = self.store.state()
        self.assertEqual(0, state["revision"])
        self.assertEqual({"speed": 457, "direction": 458}, state["channels"])
        self.assertEqual({"stop": 0, "mid": 60, "max": 230}, state["levels"]["speeds"])
        self.assertEqual({"cw": 0, "ccw": 255}, state["levels"]["directions"])
        self.assertEqual({"mid": 130, "max": 500}, state["levels"]["rpm"])
        self.assertEqual(
            {"unitId": 1, "speed": "stop", "direction": "cw", "value": 0, "directionValue": 0, "rpm": 0},
            state["units"][0],
        )
        self.assertEqual([1, 2, 3, 4, 5], [unit["unitId"] for unit in state["units"]])

    def test_commands_target_units_and_keep_omitted_fields(self):
        self.store.apply({"speed": "mid"})
        self.assertEqual((("mid", "cw"),) * 5, self.store.snapshot())
        state = self.store.apply({"unitIds": [2, 4], "speed": "max", "direction": "ccw"})
        self.assertEqual(
            (("mid", "cw"), ("max", "ccw"), ("mid", "cw"), ("max", "ccw"), ("mid", "cw")), self.store.snapshot(),
        )
        self.assertEqual({"unitId": 2, "speed": "max", "direction": "ccw", "value": 230, "directionValue": 255,
                          "rpm": 500}, state["units"][1])
        self.assertEqual(130, state["units"][0]["rpm"])
        self.store.apply({"unitIds": [4], "direction": "cw"})
        self.assertEqual(("max", "cw"), self.store.snapshot()[3])
        self.assertEqual(3, self.store.state()["revision"])

    def test_unchanged_command_keeps_revision(self):
        self.store.apply({"speed": "stop", "direction": "cw"})
        self.assertEqual(0, self.store.state()["revision"])

    def test_invalid_commands_change_nothing(self):
        self.store.apply({"unitIds": [1], "speed": "max"})
        before = self.store.snapshot()
        for raw, message in [
            ([], "motor command must be"),
            ({"enabled": True}, "motor command must be"),
            ({"speed": "max", "rpm": 500}, "motor command must be"),
            ({}, "speed and/or direction"),
            ({"unitIds": [1]}, "speed and/or direction"),
            ({"speed": "fast"}, "speed must be one of stop, mid, max"),
            ({"speed": 230}, "speed must be one of"),
            ({"direction": "left"}, "direction must be one of cw, ccw"),
            ({"unitIds": [], "speed": "max"}, "non-empty list of 1..5"),
            ({"unitIds": 1, "speed": "max"}, "non-empty list"),
            ({"unitIds": [0], "speed": "max"}, "non-empty list"),
            ({"unitIds": [6], "speed": "max"}, "non-empty list"),
            ({"unitIds": [True], "speed": "max"}, "non-empty list"),
            ({"unitIds": [1.0], "speed": "max"}, "non-empty list"),
            ({"unitIds": [2, 2], "speed": "max"}, "must not repeat"),
            ({"unitIds": [2, 9], "speed": "max"}, "non-empty list"),
        ]:
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, message):
                self.store.apply(raw)
        self.assertEqual(before, self.store.snapshot())
        self.assertEqual(1, self.store.state()["revision"])

    def test_restart_comes_back_stopped(self):
        self.store.apply({"speed": "max", "direction": "ccw"})
        self.assertEqual(tuple(STOPPED), MotorStore(DEFAULT_MOTOR, 5).snapshot())


class HardwareStoreTests(unittest.TestCase):
    def test_moon_correction_toggles_in_memory_and_resets_to_config(self):
        store = HardwareStore(DEFAULT_HARDWARE, 152)
        self.assertEqual(
            {"colorOrder": "GRB", "brightness": 0.4, "moonCorrection": True, "moonCorrectionDefault": True,
             "pixels": 152},
            store.state(),
        )
        self.assertFalse(store.apply({"moonCorrection": False})["moonCorrection"])
        self.assertFalse(store.moon_correction())
        self.assertTrue(DEFAULT_HARDWARE["moon_correction"])  # config is never mutated
        self.assertTrue(HardwareStore(DEFAULT_HARDWARE, 152).moon_correction())
        off = HardwareStore({**DEFAULT_HARDWARE, "moon_correction": False}, 152)
        self.assertFalse(off.state()["moonCorrection"])

    def test_rejects_anything_but_one_boolean(self):
        store = HardwareStore(DEFAULT_HARDWARE, 152)
        for raw in [{}, {"moonCorrection": 1}, {"moonCorrection": "false"}, {"moonCorrection": False, "brightness": 1},
                    {"brightness": 1}, [False]]:
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, "hardware command must be"):
                store.apply(raw)
        self.assertTrue(store.moon_correction())


class MotorApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.preset_path = self.root / "preset.json"
        self.preset_path.write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
        self.store = PresetStore(self.preset_path, 152)
        self.motor = MotorStore(DEFAULT_MOTOR, 5)
        self.hardware = HardwareStore(DEFAULT_HARDWARE, 152)
        self.playback = PlaybackMonitor(40, 5)
        self.server = make_server(self.store, CONFIG, 0, motor_store=self.motor, hardware_store=self.hardware,
                                  playback_monitor=self.playback)
        self.worker = Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=2)
        self.directory.cleanup()

    def get(self, path):
        with urlopen(self.base + path) as response:
            return json.load(response)

    def put(self, path, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        with urlopen(Request(self.base + path, data, {"Content-Type": content_type}, method="PUT")) as response:
            return json.load(response)

    def put_error(self, path, body, content_type="application/json"):
        with self.assertRaises(HTTPError) as caught:
            self.put(path, body, content_type)
        caught.exception.close()
        return caught.exception.code

    def test_state_reports_motor_and_hardware(self):
        state = self.get("/api/state")
        self.assertEqual(self.motor.state(), state["motor"])
        self.assertEqual(self.hardware.state(), state["hardware"])
        self.assertEqual("center-out-sine", state["preset"]["effectId"])

    def test_motor_command_returns_full_state_without_touching_preset(self):
        state = self.put("/api/motor", {"unitIds": [1, 5], "speed": "max", "direction": "ccw"})
        self.assertEqual(["max", "stop", "stop", "stop", "max"], [unit["speed"] for unit in state["motor"]["units"]])
        self.assertEqual(255, state["motor"]["units"][4]["directionValue"])
        self.assertEqual(0, state["revision"])  # preset revision only counts preset changes
        self.assertEqual("center-out-sine", state["preset"]["effectId"])
        self.assertIn("hardware", state)
        self.assertEqual(("max", "ccw"), self.motor.snapshot()[0])
        self.assertEqual(["preset.json"], sorted(os.listdir(self.root)))  # memory only, nothing written
        self.assertEqual(state["motor"], self.get("/api/state")["motor"])

    def test_hardware_command_toggles_moon_correction(self):
        state = self.put("/api/hardware", {"moonCorrection": False})
        self.assertFalse(state["hardware"]["moonCorrection"])
        self.assertFalse(self.hardware.moon_correction())
        self.assertIn("motor", state)
        self.assertTrue(self.put("/api/hardware", {"moonCorrection": True})["hardware"]["moonCorrection"])
        self.assertEqual(["preset.json"], sorted(os.listdir(self.root)))

    def test_preset_response_includes_motor_and_hardware(self):
        self.put("/api/motor", {"speed": "mid"})
        state = self.put("/api/preset", default_preset("random-leds"))
        self.assertEqual(1, state["revision"])
        self.assertEqual(["mid"] * 5, [unit["speed"] for unit in state["motor"]["units"]])
        self.assertTrue(state["hardware"]["moonCorrection"])

    def test_request_rules(self):
        self.put("/api/motor", {"unitIds": [3], "speed": "max"})
        self.put("/api/hardware", {"moonCorrection": False})
        for path, body in [
            ("/api/motor", {"enabled": True}),  # the reference system's command is gone
            ("/api/motor", {"speed": "fast"}),
            ("/api/motor", {"unitIds": [6], "speed": "stop"}),
            ("/api/motor", b"{not json"),
            ("/api/motor", b"\xff\xfe"),
            ("/api/hardware", {"moonCorrection": 0}),
            ("/api/hardware", {"moonCorrection": True, "brightness": 1}),
        ]:
            with self.subTest(path=path, body=body):
                self.assertEqual(422, self.put_error(path, body))
        self.assertEqual(415, self.put_error("/api/motor", {"speed": "stop"}, "text/plain"))
        self.assertEqual(415, self.put_error("/api/hardware", {"moonCorrection": True}, "text/plain"))
        self.assertEqual(413, self.put_error("/api/motor", {"unitIds": [1] * 100, "speed": "stop"}))
        self.assertEqual(413, self.put_error("/api/hardware", {"moonCorrection": True, "padding": "x" * 64}))
        self.assertEqual(413, self.put_error("/api/motor", b""))
        self.assertEqual(("max", "cw"), self.motor.snapshot()[2])
        self.assertTrue(all(speed == "stop" for index, (speed, _) in enumerate(self.motor.snapshot()) if index != 2))
        self.assertFalse(self.hardware.moon_correction())

    def test_largest_valid_motor_command_fits_the_limit(self):
        body = {"unitIds": [1, 2, 3, 4, 5, 6, 7, 8, 9], "speed": "stop", "direction": "ccw"}
        self.assertLessEqual(len(json.dumps(body, indent=2).encode()), 256)

    def test_playback_carries_motor_while_active(self):
        self.assertEqual({"active": False}, self.get("/api/playback"))
        self.put("/api/motor", {"unitIds": [2], "speed": "max", "direction": "ccw"})
        self.playback.report("single", validate_preset(default_preset("center-out-sine"), 152), 0, 10)
        playback = self.get("/api/playback")
        self.assertTrue(playback["active"])
        self.assertEqual({"speed": "max", "direction": "ccw"}, playback["motor"][1])
        self.assertEqual({"speed": "stop", "direction": "cw"}, playback["motor"][0])
        self.assertEqual(5, len(playback["motor"]))


if __name__ == "__main__":
    unittest.main()
