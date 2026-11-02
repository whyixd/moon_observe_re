import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from moon_observe_backend.config import load_config
from moon_observe_backend.control import PresetStore, make_server
from moon_observe_backend.effects import default_preset, validate_preset
from moon_observe_backend.output import stream
from moon_observe_backend.renderer import render_frame, rgb_bytes
from moon_observe_backend.sequence import compile_sequence, render_sequence_frame
from moon_observe_backend.weather import WeatherStore, category_for, gradient_for


class FakeClient:
    def __init__(self, ip, universe, packet_size, **_kwargs):
        self.ip = ip
        self.universe = universe
        self.packet_size = packet_size
        self.packets = []
        self.closed = False

    def set_simplified(self, _value):
        pass

    def set_net(self, _value):
        pass

    def set_subnet(self, _value):
        pass

    def send(self, payload):
        self.packets.append(payload)

    def close(self):
        self.closed = True


class WeatherTests(unittest.TestCase):
    def test_weather_classification_and_palette(self):
        self.assertEqual("clear", category_for(1))
        self.assertEqual("cloudy", category_for(45))
        self.assertEqual("rain", category_for(61))
        self.assertEqual("rain", category_for(73))
        self.assertNotEqual(gradient_for(17), gradient_for(28))
        values = iter([
            {"weather_code": 61, "temperature_2m": 17, "time": "first"},
            {"weather_code": 63, "temperature_2m": 28, "time": "second"},
            {"weather_code": 3, "temperature_2m": 21, "time": "third"},
            {"weather_code": 999, "temperature_2m": 21, "time": "bad"},
        ])
        store = WeatherStore(
            {"latitude": 25.0, "longitude": 121.0, "cloud_step": 6, "interval_minutes": 15},
            9, fetch=lambda *_args: next(values),
        )
        store.refresh()
        first = store.snapshot()
        self.assertEqual("rain", first["category"])
        self.assertEqual([0.0] * 9, first["startPhases"])  # Rain no longer delays units.
        store.refresh()
        second = store.snapshot()
        self.assertEqual(first["generation"], second["generation"])
        self.assertNotEqual(first["color"], second["color"])
        store.refresh()
        cloudy = store.snapshot()
        self.assertEqual("cloudy", cloudy["category"])
        self.assertEqual(6, cloudy["frameStep"])
        self.assertEqual([0] * 9, cloudy["startPhases"])
        self.assertEqual(first["generation"] + 1, cloudy["generation"])
        store.refresh()
        self.assertEqual("cloudy", store.snapshot()["category"])
        self.assertIsNotNone(store.snapshot()["error"])

    def test_override_restarts_survives_refresh_and_expires(self):
        now = [0.0]
        values = iter([
            {"weather_code": 3, "temperature_2m": 21},
            {"weather_code": 0, "temperature_2m": 30},
        ])
        store = WeatherStore(
            {"latitude": 25.0, "longitude": 121.0, "cloud_step": 6, "interval_minutes": 15},
            9, fetch=lambda *_args: next(values), clock=lambda: now[0],
        )
        store.refresh()
        real = store.snapshot()
        self.assertIsNone(real["override"])

        rain = store.set_override({"category": "rain", "temperatureC": 10})
        self.assertEqual("rain", rain["category"])
        self.assertEqual(gradient_for(10), rain["color"])
        self.assertEqual(real["generation"] + 1, rain["generation"])
        self.assertEqual({"category": "rain", "temperatureC": 10.0, "remainingSeconds": 600.0}, rain["override"])
        self.assertEqual({"category": "cloudy", "temperatureC": 21.0}, rain["real"])

        again = store.set_override({"category": "rain", "temperatureC": 10})
        self.assertEqual(rain["generation"] + 1, again["generation"])

        now[0] = 300.0
        store.refresh()
        during = store.snapshot()
        self.assertEqual("rain", during["category"])
        self.assertEqual(again["generation"], during["generation"])
        self.assertEqual("clear", during["real"]["category"])
        self.assertEqual(300.0, during["override"]["remainingSeconds"])

        now[0] = 600.0
        expired = store.snapshot()
        self.assertIsNone(expired["override"])
        self.assertEqual("clear", expired["category"])
        self.assertEqual(gradient_for(30), expired["color"])
        self.assertEqual([0] * 9, expired["startPhases"])
        self.assertEqual(during["generation"] + 1, expired["generation"])

        store.set_override({"category": "clear", "temperatureC": 30})
        cleared = store.clear_override()
        self.assertIsNone(cleared["override"])
        self.assertEqual("clear", cleared["category"])

        for raw in (
            {"category": "snow", "temperatureC": 1},
            {"category": "rain", "temperatureC": True},
            {"category": "rain", "temperatureC": 71},
            {"category": "rain"},
            {"category": "rain", "temperatureC": 1, "extra": 1},
        ):
            with self.assertRaises(ValueError):
                store.set_override(raw)

    def test_override_api_and_missing_weather(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "preset.json"
            path.write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            store = PresetStore(path, 156)
            weather = WeatherStore(
                {"latitude": 25.0, "longitude": 121.0, "cloud_step": 6, "interval_minutes": 15},
                9, fetch=lambda *_args: {"weather_code": 3, "temperature_2m": 24},
            )
            weather.refresh()
            config = {
                "ip": "127.0.0.1", "universe": 0, "source_ip": None,
                "fps": 40, "rpm": 360, "pixels": 156, "unit_id": 1, "unit_count": 9,
            }

            def call(server, method, body=None):
                data = None if body is None else json.dumps(body).encode("utf-8")
                request = Request(
                    f"http://127.0.0.1:{server.server_address[1]}/api/weather/override",
                    data=data, method=method, headers={"Content-Type": "application/json"},
                )
                try:
                    with urlopen(request) as response:
                        return response.status, json.load(response)
                except HTTPError as error:
                    return error.code, json.load(error)

            for weather_store in (weather, None):
                with make_server(store, config, 0, weather_store=weather_store) as server:
                    worker = Thread(target=server.serve_forever, daemon=True)
                    worker.start()
                    try:
                        if weather_store is None:
                            self.assertEqual(404, call(server, "PUT", {"category": "rain", "temperatureC": 1})[0])
                            self.assertEqual(404, call(server, "DELETE")[0])
                            continue
                        status, state = call(server, "PUT", {"category": "rain", "temperatureC": 30})
                        self.assertEqual(200, status)
                        self.assertEqual("rain", state["category"])
                        self.assertEqual("rain", weather.snapshot()["override"]["category"])
                        self.assertEqual(422, call(server, "PUT", {"category": "hail", "temperatureC": 1})[0])
                        status, state = call(server, "DELETE")
                        self.assertEqual(200, status)
                        self.assertIsNone(state["override"])
                        self.assertEqual("cloudy", state["category"])
                    finally:
                        server.shutdown()
                        worker.join(timeout=2)

    def test_weather_api_exposes_the_render_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "preset.json"
            path.write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            store = PresetStore(path, 156)
            weather = WeatherStore(
                {"latitude": 25.0, "longitude": 121.0, "cloud_step": 6, "interval_minutes": 15},
                9, fetch=lambda *_args: {"weather_code": 3, "temperature_2m": 24},
            )
            weather.refresh()
            config = {
                "ip": "127.0.0.1", "universe": 0, "source_ip": None,
                "fps": 40, "rpm": 360, "pixels": 156, "unit_id": 1, "unit_count": 9,
            }
            with make_server(store, config, 0, weather_store=weather) as server:
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    with urlopen(f"http://127.0.0.1:{server.server_address[1]}/api/weather") as response:
                        state = json.load(response)
                    self.assertEqual(weather.snapshot(), state)
                finally:
                    server.shutdown()
                    worker.join(timeout=2)

    def test_multi_target_config_and_weather(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "preset.json").write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            config_path = root / "config.toml"
            config_path.write_text(
                '[artnet]\n[[artnet.targets]]\nunit_id = 1\nip = "192.0.2.1"\nuniverse = 0\n'
                '[[artnet.targets]]\nunit_id = 2\nip = "192.0.2.2"\nuniverse = 1\n'
                '[render]\npreset = "preset.json"\nunit_count = 9\n'
                '[weather]\nlatitude = 25.0\nlongitude = 121.0\ncloud_step = 8\n',
                encoding="utf-8",
            )
            config, _ = load_config(config_path)
            self.assertEqual(2, len(config["targets"]))
            self.assertEqual(8, config["weather"]["cloud_step"])
            config_path.write_text(config_path.read_text(encoding="utf-8").replace("unit_id = 2", "unit_id = 1"), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unit_id values must be unique"):
                load_config(config_path)

    def test_shared_frame_clear_cloudy_and_rain_lines(self):
        config = {
            "ip": "192.0.2.1", "universe": 0, "source_ip": None,
            "fps": 40, "rpm": 360, "pixels": 156, "unit_id": 1, "unit_count": 9,
            "targets": [
                {"unit_id": unit_id, "ip": f"192.0.2.{unit_id}", "universe": unit_id - 1}
                for unit_id in range(1, 10)
            ],
        }
        preset = validate_preset(default_preset("center-out-sine"))
        weather = {
            "category": "clear", "generation": 1, "frameStep": 0,
            "startPhases": [0.0] * 9, "color": gradient_for(20),
        }

        def run(state, duration):
            now = [0.0]
            clients = []
            def factory(*args, **kwargs):
                client = FakeClient(*args, **kwargs)
                clients.append(client)
                return client
            count = stream(
                config, preset, seconds=duration, client_factory=factory,
                weather_provider=lambda: state, clock=lambda: now[0],
                sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
            )
            self.assertEqual(count, sum(len(client.packets) for client in clients))
            self.assertTrue(all(client.closed for client in clients))
            return clients

        clear = run(weather, 0.01)
        self.assertEqual(9, len(clear))
        self.assertEqual(clear[0].packets[0][:468], clear[8].packets[0][:468])
        cloudy = run({**weather, "category": "cloudy", "frameStep": 6}, 0.01)
        self.assertNotEqual(cloudy[0].packets[0][:468], cloudy[1].packets[0][:468])
        expected = rgb_bytes(render_frame(
            preset, {"unitId": 2, "logicalPixelCount": 156, "frameOffset": 6},
            0, color_override=weather["color"],
        ))
        self.assertEqual(expected, cloudy[1].packets[0][:468])
        rain = run({**weather, "category": "rain", "frameStep": 0}, 2.0)
        for unit_index, client in enumerate(rain):
            for frame, packet in enumerate(client.packets):
                expected = rgb_bytes(render_frame(
                    preset, {"unitId": unit_index + 1, "logicalPixelCount": 156, "frameOffset": 0},
                    frame, color_override=weather["color"], raining=True,
                ))
                self.assertEqual(expected, packet[:468], f"unit {unit_index + 1} frame {frame}")
        self.assertNotEqual(clear[0].packets[0][:468], rain[0].packets[0][:468])

    def test_rain_lines_follow_each_sequence_step(self):
        comet = validate_preset(default_preset("comet-tail"))

        raw = {
            "schemaVersion": 1, "ending": {"kind": "hold"},
            "steps": [{
                "id": 1, "preset": default_preset("comet-tail"),
                "playback": {"kind": "count", "count": 3},
                "transition": {"kind": "cut", "seconds": 0},
            }],
        }
        compiled = compile_sequence(raw, 40, 9)
        unit = {"unitId": 2, "logicalPixelCount": 156, "frameOffset": 0}
        render = lambda frame: render_sequence_frame(compiled, unit, frame, unit_count=9, fps=40, rpm=360, rain=True)
        for frame in range(160, 480):
            expected = render_frame(comet, unit, frame % 160, unit_count=9, fps=40, rpm=360, phase_frame=frame, raining=True)
            self.assertEqual(expected, render(frame), frame)


if __name__ == "__main__":
    unittest.main()
