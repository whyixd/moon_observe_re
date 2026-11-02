from datetime import datetime
import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from moon_observe_backend.config import load_config
from moon_observe_backend.control import PresetStore, make_server
from moon_observe_backend.effects import completion_frames, default_preset, validate_preset
from moon_observe_backend.output import boundary_key, round_length, stream
from moon_observe_backend.sequence import compile_sequence
from moon_observe_backend.weather import WeatherStore, gradient_for

CONFIG = {
    "ip": "127.0.0.1", "source_ip": None, "universe": 0,
    "fps": 40, "rpm": 360, "pixels": 156, "unit_id": 1, "unit_count": 9,
}
VISITS = [
    {"name": "東京", "latitude": 35.7, "longitude": 139.7},
    {"name": "倫敦", "latitude": 51.5, "longitude": -0.1},
]
WEATHER = {"latitude": 25.0, "longitude": 121.0, "cloud_step": 6, "interval_minutes": 15, "visits": VISITS}
RESPONSES = {
    25.0: {"weather_code": 0, "temperature_2m": 30, "time": "local"},
    35.7: {"weather_code": 61, "temperature_2m": 12, "time": "tokyo"},
    51.5: {"weather_code": 3, "temperature_2m": 5, "time": "london"},
}


class FakeClient:
    def __init__(self, *_args, **_kwargs): pass
    def set_simplified(self, _value): pass
    def set_net(self, _value): pass
    def set_subnet(self, _value): pass
    def send(self, _payload): pass
    def close(self): pass


def four_frame_sequence(ending):
    step = {"preset": default_preset("center-out-sine"), "playback": {"kind": "time", "seconds": 0.05},
            "transition": {"kind": "cut", "seconds": 0.5}}
    return compile_sequence({"schemaVersion": 1, "ending": {"kind": ending},
                             "steps": [{"id": 1, **step}, {"id": 2, **step}]}, 40, 9)


class Hour:
    def __init__(self):
        self.hour = 10
        self.minute = 30

    def __call__(self):
        return datetime(2026, 10, 11, self.hour, self.minute)


def make_store(fetch=None):
    hour = Hour()
    store = WeatherStore(WEATHER, 9, fetch=fetch or (lambda latitude, _longitude: RESPONSES[latitude]), now=hour)
    store.refresh()
    store.refresh_visits()
    store.snapshot()  # Records the starting hour; no visit is queued for it.
    return store, hour


class VisitConfigTests(unittest.TestCase):
    def test_visits_are_parsed_and_validated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "preset.json").write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            config_path = root / "config.toml"
            base = ('[artnet]\nip = "192.0.2.1"\n[render]\npreset = "preset.json"\n'
                    '[weather]\nlatitude = 25.0\nlongitude = 121.0\n')
            config_path.write_text(base, encoding="utf-8")
            self.assertEqual([], load_config(config_path)[0]["weather"]["visits"])
            config_path.write_text(base + '[[weather.visits]]\nname = " 東京 "\nlatitude = 35.7\nlongitude = 139.7\n',
                                   encoding="utf-8")
            self.assertEqual([{"name": "東京", "latitude": 35.7, "longitude": 139.7}],
                             load_config(config_path)[0]["weather"]["visits"])
            for bad in ('name = ""\nlatitude = 1\nlongitude = 1\n', 'name = "x"\nlatitude = 91\nlongitude = 1\n',
                        'name = "x"\nlatitude = 1\n', 'name = "x"\nlatitude = 1\nlongitude = 1\nextra = 1\n'):
                config_path.write_text(base + "[[weather.visits]]\n" + bad, encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_config(config_path)


class VisitScheduleTests(unittest.TestCase):
    def test_hourly_visit_switches_palette_on_the_hour_and_defers_timing(self):
        store, hour = make_store()
        local = store.snapshot()
        self.assertEqual(("local", None, "clear", False), (local["source"], local["visit"], local["category"], local["categoryPending"]))
        self.assertEqual({"count": 2, "next": "東京", "names": ["東京", "倫敦"]}, local["visits"])
        generation = local["generation"]

        hour.hour = 11
        tokyo = store.snapshot()
        self.assertEqual("visit", tokyo["source"])
        self.assertEqual({"name": "東京", "category": "rain", "temperatureC": 12.0, "observedAt": "tokyo"}, tokyo["visit"])
        # The palette switches on the hour; the rain timing waits for the next step; playback is not restarted.
        self.assertEqual((gradient_for(12), "clear", True, generation),
                         (tokyo["color"], tokyo["category"], tokyo["categoryPending"], tokyo["generation"]))
        self.assertEqual("倫敦", tokyo["visits"]["next"])

        store.advance(1, 100, False, False)
        self.assertEqual("clear", store.snapshot()["category"])
        store.advance(1, 100, True, False)
        rain = store.snapshot()
        self.assertEqual(("rain", False, generation), (rain["category"], rain["categoryPending"], rain["generation"]))

        store.refresh()  # A local update during the visit must not restart playback.
        self.assertEqual(generation, store.snapshot()["generation"])

        store.advance(97, 100, False, False)
        self.assertEqual("visit", store.snapshot()["source"])  # 1 + 1 + 97 frames of 100.
        store.advance(1, 100, False, False)
        back = store.snapshot()
        self.assertEqual(("local", gradient_for(30), "rain", True), (back["source"], back["color"], back["category"], back["categoryPending"]))
        store.advance(1, 100, True, False)
        self.assertEqual(("clear", False, generation), (store.snapshot()["category"], store.snapshot()["categoryPending"],
                                                        store.snapshot()["generation"]))

        hour.hour = 12
        self.assertEqual("倫敦", store.snapshot()["visit"]["name"])
        hour.hour = 13  # A new hour replaces a visit still running.
        self.assertEqual("東京", store.snapshot()["visit"]["name"])

    def test_single_effect_does_not_restart_at_a_deferred_category(self):
        store, hour = make_store()
        generation = store.snapshot()["generation"]
        hour.hour = 11
        store.snapshot()
        store.advance(1, 100, True, True)
        self.assertEqual(("rain", generation), (store.snapshot()["category"], store.snapshot()["generation"]))
        hour.hour = 12
        store.snapshot()
        store.advance(1, 100, True, True)
        self.assertEqual(("cloudy", generation), (store.snapshot()["category"], store.snapshot()["generation"]))

    def test_failed_fetch_reuses_last_data_and_unfetched_locations_are_skipped(self):
        responses = dict(RESPONSES)

        def fetch(latitude, _longitude):
            if latitude not in responses:
                raise OSError("offline")
            return responses[latitude]

        store, hour = make_store(fetch)
        responses.clear()
        store.refresh_visits()
        hour.hour = 11
        self.assertEqual({"name": "東京", "category": "rain", "temperatureC": 12.0, "observedAt": "tokyo"},
                         store.snapshot()["visit"])

        responses.update(RESPONSES)
        del responses[35.7]
        skipped, skipped_hour = make_store(fetch)
        skipped_hour.hour = 11
        self.assertEqual("倫敦", skipped.snapshot()["visit"]["name"])  # 東京 was never fetched.

        responses.clear()
        empty, empty_hour = make_store(fetch)
        empty_hour.hour = 11
        self.assertEqual("local", empty.snapshot()["source"])

    def test_manual_override_skips_the_hour(self):
        now = [0.0]
        hour = Hour()
        store = WeatherStore(WEATHER, 9, fetch=lambda latitude, _longitude: RESPONSES[latitude],
                             clock=lambda: now[0], now=hour)
        store.refresh()
        store.refresh_visits()
        store.snapshot()
        store.set_override({"category": "cloudy", "temperatureC": 0})
        hour.hour = 11
        self.assertEqual(("override", "東京"), (store.snapshot()["source"], store.snapshot()["visits"]["next"]))
        now[0] = 600.0
        self.assertEqual("local", store.snapshot()["source"])
        hour.hour = 12
        self.assertEqual("東京", store.snapshot()["visit"]["name"])

    def test_prefetch_waits_until_minute_58(self):
        store, hour = make_store()
        self.assertEqual(28 * 60, store.seconds_until_prefetch())  # 10:30 -> 10:58
        hour.minute = 58
        self.assertEqual(3600, store.seconds_until_prefetch())
        self.assertEqual(float("inf"), WeatherStore({**WEATHER, "visits": []}, 9).seconds_until_prefetch())


class ManualVisitTests(unittest.TestCase):
    def test_manual_visit_starts_now_keeps_rotation_and_can_end_early(self):
        responses = dict(RESPONSES)

        def fetch(latitude, _longitude):
            if latitude not in responses:
                raise OSError("offline")
            return responses[latitude]

        store, _ = make_store(fetch)
        local = store.snapshot()
        london = store.start_visit({"index": 1})
        # Like an hourly visit: palette now, cloudy timing at the next step, no restart.
        self.assertEqual(("visit", "倫敦", "clear", True, gradient_for(5)),
                         (london["source"], london["visit"]["name"], london["category"], london["categoryPending"], london["color"]))
        self.assertEqual(local["generation"], london["generation"])
        self.assertEqual("東京", london["visits"]["next"])
        store.advance(1, 4, False, False)
        store.advance(1, 4, True, False)
        self.assertEqual(("cloudy", False), (store.snapshot()["category"], store.snapshot()["categoryPending"]))
        store.advance(2, 4, False, False)
        self.assertEqual("visit", store.snapshot()["source"])  # Frames 0..3 of one 4-frame round.
        store.advance(1, 4, True, False)
        self.assertEqual(("local", "clear", local["generation"]),
                         (store.snapshot()["source"], store.snapshot()["category"], store.snapshot()["generation"]))

        del responses[35.7]  # Fetch fails: the last good data is used.
        self.assertEqual("tokyo", store.start_visit({"index": 0})["visit"]["observedAt"])
        ended = store.end_visit()
        # Ended before the next step: rain never applied, so nothing is left pending.
        self.assertEqual(("local", gradient_for(30), "clear", False, local["generation"]),
                         (ended["source"], ended["color"], ended["category"], ended["categoryPending"], ended["generation"]))

        for raw in ({}, {"index": 2}, {"index": -1}, {"index": True}, {"index": 0, "extra": 1}):
            with self.assertRaises(ValueError):
                store.start_visit(raw)
        store.set_override({"category": "rain", "temperatureC": 1})
        with self.assertRaisesRegex(ValueError, "manual test weather"):
            store.start_visit({"index": 1})

        responses.clear()
        empty, _ = make_store(fetch)
        with self.assertRaisesRegex(ValueError, "no weather data"):
            empty.start_visit({"index": 0})

    def test_visit_api(self):
        store, _ = make_store()
        with tempfile.TemporaryDirectory() as directory:
            preset_path = Path(directory) / "preset.json"
            preset_path.write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            with make_server(PresetStore(preset_path, 156), CONFIG, 0, weather_store=store) as server:
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    url = f"http://127.0.0.1:{server.server_address[1]}/api/weather/visit"
                    start = Request(url, json.dumps({"index": 0}).encode(), {"Content-Type": "application/json"}, method="PUT")
                    with urlopen(start) as response:
                        self.assertEqual("東京", json.load(response)["visit"]["name"])
                    with urlopen(Request(url, method="DELETE")) as response:
                        self.assertEqual("local", json.load(response)["source"])
                    invalid = Request(url, json.dumps({"index": 5}).encode(), {"Content-Type": "application/json"}, method="PUT")
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(invalid)
                    self.assertEqual(422, caught.exception.code)
                finally:
                    server.shutdown()
                    worker.join(timeout=2)


class VisitStreamTests(unittest.TestCase):
    def test_round_length(self):
        self.assertEqual((4, True), round_length(four_frame_sequence("loop"), {}, 40, 9))
        self.assertEqual((4, False), round_length(four_frame_sequence("hold"), {}, 40, 9))
        sine = validate_preset(default_preset("center-out-sine"), 156)
        cycle = round_length(None, sine, 40, 9)[0]
        self.assertGreaterEqual(cycle, 2400)
        self.assertLess(cycle, 2400 + 40 / sine["parameters"]["speedHz"] + 1)
        self.assertEqual((2400, True), round_length(None, validate_preset(default_preset("random-leds"), 156), 40, 9))

    def test_boundary_key(self):
        loop = four_frame_sequence("loop")
        self.assertEqual([(0, 0), (0, 0), (0, 1), (0, 1), (1, 0)],
                         [boundary_key(loop, {}, frame, 40, 9) for frame in range(5)])
        hold = four_frame_sequence("hold")
        self.assertEqual([(0, 1), None], [boundary_key(hold, {}, frame, 40, 9) for frame in (3, 4)])
        sine = validate_preset(default_preset("center-out-sine"), 156)
        cycle = completion_frames(sine, 40, 9)
        self.assertEqual([(0, 0), (0, 1)], [boundary_key(None, sine, frame, 40, 9) for frame in (cycle - 1, cycle)])
        self.assertEqual((0, 1), boundary_key(None, validate_preset(default_preset("random-leds"), 156), 2400, 40, 9))

    def test_visit_switches_palette_on_the_hour_and_rain_at_the_next_step(self):
        store, hour = make_store()
        schedule = four_frame_sequence("loop")
        frames = []
        now = [0.0]

        def sleep(value):
            now[0] += value

        def reporter(_mode, _schedule, restart, frame):
            weather = store.snapshot()
            frames.append((restart, frame, weather["source"], weather["category"]))
            if len(frames) == 1:
                hour.hour = 11

        stream(CONFIG, default_preset("center-out-sine"), seconds=8 / 40, client_factory=FakeClient,
               sequence_provider=lambda: ("sequence", schedule, 0), weather_provider=store.snapshot,
               playback_reporter=reporter, playback_advance=store.advance,
               clock=lambda: now[0], sleep=sleep)
        # Hour at frame 1: palette now, rain from step 2 (frame 2), back home after one round (frame 5),
        # clear again from the next step (frame 6). Playback never restarts.
        self.assertEqual([(1, 0, "local", "clear"), (1, 1, "visit", "clear"), (1, 2, "visit", "rain"),
                          (1, 3, "visit", "rain"), (1, 4, "visit", "rain"), (1, 5, "local", "rain"),
                          (1, 6, "local", "clear"), (1, 7, "local", "clear")], frames)

if __name__ == "__main__":
    unittest.main()
