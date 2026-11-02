import copy
import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from moon_observe_backend.config import load_config
from moon_observe_backend.control import PresetStore, make_server
from moon_observe_backend.effects import default_preset
from moon_observe_backend.palette import DEFAULT_PALETTE, MAX_BANDS, PaletteStore, gradient_for, load_palette, validate_palette
from moon_observe_backend.weather import WeatherStore

WEATHER = {"latitude": 25.0, "longitude": 121.0, "cloud_step": 6, "interval_minutes": 15}
RED = {"r": 1, "g": 0, "b": 0}
BLUE = {"r": 0, "g": 0, "b": 1}


def two_band(below=10):
    return {
        "schemaVersion": 1, "axis": "strip",
        "bands": [{"belowC": below, "colors": [RED, BLUE]}, {"belowC": None, "colors": [BLUE, RED]}],
    }


def banded(count):
    bands = [{"belowC": -50 + 5 * index, "colors": [RED, BLUE]} for index in range(count - 1)]
    return {**two_band(), "bands": bands + [{"belowC": None, "colors": [RED, BLUE]}]}


class PaletteTests(unittest.TestCase):
    def test_default_matches_previous_thresholds_and_colors(self):
        self.assertEqual(DEFAULT_PALETTE, validate_palette(DEFAULT_PALETTE))
        self.assertEqual(gradient_for(17.9)["colors"][0], {"r": 0x24 / 255, "g": 0x44 / 255, "b": 0xAA / 255})
        self.assertEqual(gradient_for(18), gradient_for(27.9))
        self.assertNotEqual(gradient_for(27.9), gradient_for(28))
        self.assertEqual("radius", gradient_for(40)["axis"])

    def test_validation(self):
        single = {"schemaVersion": 1, "axis": "radius", "bands": [{"belowC": None, "colors": [RED, BLUE]}]}
        self.assertEqual(single["bands"][0]["colors"], validate_palette(single)["bands"][0]["colors"])
        self.assertEqual(MAX_BANDS, len(validate_palette(banded(MAX_BANDS))["bands"]))
        bad = [
            {**two_band(), "axis": "diagonal"},
            {**two_band(), "bands": []},
            {**two_band(), "bands": [{"belowC": 10, "colors": [RED, BLUE]}]},
            {**two_band(), "bands": [{"belowC": None, "colors": [RED, BLUE]}] * 2},
            {**two_band(), "bands": [{"belowC": 10, "colors": [RED, BLUE]}, {"belowC": 5, "colors": [RED, BLUE]},
                                     {"belowC": None, "colors": [RED, BLUE]}]},
            {**two_band(), "bands": [{"belowC": 10, "colors": [RED]}, {"belowC": None, "colors": [RED, BLUE]}]},
            banded(MAX_BANDS + 1),
            two_band(below=71),
            two_band(below=True),
            {**two_band(), "extra": 1},
        ]
        for raw in bad:
            with self.assertRaises(ValueError, msg=json.dumps(raw)):
                validate_palette(raw)

    def test_store_saves_and_weather_uses_it_immediately(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "palette.json"
            self.assertEqual(DEFAULT_PALETTE, load_palette(path))
            palette = PaletteStore(path)
            weather = WeatherStore(WEATHER, 9, fetch=lambda *_args: {"weather_code": 0, "temperature_2m": 5}, palette=palette)
            weather.refresh()
            before = weather.snapshot()
            self.assertEqual([18, 28], before["thresholds"])
            palette.apply(two_band())
            after = weather.snapshot()
            self.assertEqual({"mode": "gradient", "axis": "strip", "colors": [
                {"r": 1.0, "g": 0.0, "b": 0.0}, {"r": 0.0, "g": 0.0, "b": 1.0},
            ]}, after["color"])
            self.assertEqual([10], after["thresholds"])
            self.assertEqual(before["generation"], after["generation"])
            self.assertEqual(palette.state(), PaletteStore(path).state())
            with self.assertRaises(ValueError):
                palette.apply({"schemaVersion": 1})
            self.assertEqual(palette.state(), load_palette(path))
            self.assertEqual([path], list(Path(directory).iterdir()))

    def test_config_path_and_api(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "preset.json").write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            config_path = root / "config.toml"
            config_path.write_text(
                '[artnet]\nip = "192.0.2.1"\n[render]\npreset = "preset.json"\n'
                '[weather]\nlatitude = 25.0\nlongitude = 121.0\npalette = "data/colors.json"\n',
                encoding="utf-8",
            )
            config, _ = load_config(config_path)
            self.assertEqual(str((root / "data" / "colors.json").resolve()), config["weather"]["palette_path"])

            store = PresetStore(root / "preset.json", 156)
            palette = PaletteStore(config["weather"]["palette_path"])
            weather = WeatherStore(WEATHER, 9, fetch=lambda *_args: {"weather_code": 0, "temperature_2m": 5}, palette=palette)

            def call(server, method, body=None):
                request = Request(
                    f"http://127.0.0.1:{server.server_address[1]}/api/weather/palette",
                    data=None if body is None else json.dumps(body).encode("utf-8"),
                    method=method, headers={"Content-Type": "application/json"},
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
                            self.assertEqual(404, call(server, "GET")[0])
                            self.assertEqual(404, call(server, "PUT", two_band())[0])
                            continue
                        self.assertEqual((200, DEFAULT_PALETTE), call(server, "GET"))
                        status, saved = call(server, "PUT", two_band())
                        self.assertEqual(200, status)
                        self.assertEqual([10], [band["belowC"] for band in saved["bands"][:-1]])
                        self.assertTrue((root / "data" / "colors.json").is_file())
                        broken = copy.deepcopy(two_band())
                        broken["bands"][0]["belowC"] = None
                        self.assertEqual(422, call(server, "PUT", broken)[0])
                        self.assertEqual((200, saved), call(server, "GET"))
                    finally:
                        server.shutdown()
                        worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
