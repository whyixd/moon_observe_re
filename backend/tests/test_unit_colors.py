import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from moon_observe_backend.control import PresetStore, make_server
from moon_observe_backend.effects import default_preset, validate_preset
from moon_observe_backend.output import stream
from moon_observe_backend.playback import PlaybackMonitor
from moon_observe_backend.unit_colors import UnitColorStore

from test_control import CONFIG, FakeClient

RED = {"r": 1, "g": 0, "b": 0}
BLUE = {"r": 0, "g": 0, "b": 1}


def colors(first=RED, rest=None):
    return [first] + [rest] * 8


class UnitColorTests(unittest.TestCase):
    def test_validation(self):
        store = UnitColorStore(9)
        bad = [
            None,
            {"colors": colors()},
            {"colors": colors(), "seconds": None, "extra": 1},
            {"colors": colors()[:8], "seconds": None},
            {"colors": [None] * 9, "seconds": None},
            {"colors": colors({"r": 2, "g": 0, "b": 0}), "seconds": None},
            {"colors": colors({"r": 1, "g": 0}), "seconds": None},
            {"colors": colors(), "seconds": 0},
            {"colors": colors(), "seconds": 86401},
            {"colors": colors(), "seconds": True},
            {"colors": colors(), "seconds": float("nan")},
        ]
        for raw in bad:
            with self.assertRaises(ValueError, msg=repr(raw)):
                store.apply(raw)
        self.assertFalse(store.snapshot()["active"])

    def test_timed_test_expires_and_manual_test_stays(self):
        now = [0.0]
        store = UnitColorStore(9, clock=lambda: now[0])
        state = store.apply({"colors": colors(RED, BLUE), "seconds": 30})
        self.assertEqual({"active": True, "colors": [RED] + [BLUE] * 8, "remainingSeconds": 30.0}, state)
        now[0] = 29.5
        self.assertEqual(((1.0, 0.0, 0.0),) + ((0.0, 0.0, 1.0),) * 8, store.current())
        now[0] = 30
        self.assertIsNone(store.current())
        self.assertEqual({"active": False, "colors": None, "remainingSeconds": None}, store.snapshot())

        state = store.apply({"colors": colors(), "seconds": None})
        self.assertIsNone(state["remainingSeconds"])
        self.assertEqual([RED] + [None] * 8, state["colors"])
        now[0] = 10 ** 9
        self.assertIsNotNone(store.current())
        self.assertFalse(store.clear()["active"])
        self.assertIsNone(store.current())

    def test_stream_fills_tested_units_and_keeps_motor(self):
        targets = [{"unit_id": unit_id, "ip": "127.0.0.1", "universe": unit_id - 1} for unit_id in (1, 2)]
        config = {**CONFIG, "targets": targets}
        clients = []

        def factory(*args, **kwargs):
            clients.append(FakeClient(*args, **kwargs))
            return clients[-1]

        now = [0.0]

        def sleep(seconds):
            now[0] += seconds

        store = UnitColorStore(9)
        store.apply({"colors": colors({"r": 1, "g": 0.5, "b": 0}), "seconds": None})
        stream(config, validate_preset(default_preset("center-out-sine"), 156), seconds=0.05, client_factory=factory,
               motor_provider=lambda: 255, unit_colors_provider=store.current,
               clock=lambda: now[0], sleep=sleep)
        tested, normal = clients[0].packets[0], clients[1].packets[0]
        self.assertEqual(bytes([255, 128, 0]) * 156, tested[:156 * 3])
        self.assertEqual(255, tested[468])
        self.assertNotEqual(bytes([255, 128, 0]) * 156, normal[:156 * 3])
        self.assertEqual(255, normal[468])

    def test_api(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "preset.json"
            path.write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            monitor = PlaybackMonitor(40, 9)
            monitor.report("single", validate_preset(default_preset("center-out-sine"), 156), 0, 0)
            with make_server(PresetStore(path, 156), CONFIG, 0, unit_color_store=UnitColorStore(9),
                             playback_monitor=monitor) as server:
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    base = f"http://127.0.0.1:{server.server_address[1]}"
                    url = base + "/api/test/units"
                    with urlopen(base + "/api/playback") as response:
                        self.assertNotIn("unitColors", json.load(response))
                    with urlopen(url) as response:
                        self.assertFalse(json.load(response)["active"])
                    body = json.dumps({"colors": colors(), "seconds": 60}).encode()
                    request = Request(url, body, {"Content-Type": "application/json"}, method="PUT")
                    with urlopen(request) as response:
                        self.assertTrue(json.load(response)["active"])
                    with urlopen(base + "/api/playback") as response:
                        self.assertEqual([RED] + [None] * 8, json.load(response)["unitColors"])
                    bad = Request(url, b'{"colors":[],"seconds":null}', {"Content-Type": "application/json"},
                                  method="PUT")
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(bad)
                    self.assertEqual(422, caught.exception.code)
                    with urlopen(Request(url, method="DELETE")) as response:
                        self.assertFalse(json.load(response)["active"])
                finally:
                    server.shutdown()
                    worker.join(timeout=2)
