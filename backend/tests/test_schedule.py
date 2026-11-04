from datetime import date, datetime, timedelta
import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from moon_observe_backend.config import DEFAULT_HARDWARE, DEFAULT_MOTOR, load_config
from moon_observe_backend.control import PresetStore, make_server
from moon_observe_backend.effects import default_preset, validate_preset
from moon_observe_backend.hardware import blackout_payload, build_payload
from moon_observe_backend.motor import MotorStore
from moon_observe_backend.output import stream
from moon_observe_backend.renderer import render_frame
from moon_observe_backend.schedule import (
    ScheduleStore, Scheduler, current_window, default_schedule, next_show, validate_schedule, windows_on,
)
from moon_observe_backend.sequence import SequenceStore
from support import longn_config

UNITS = 5


def document(**overrides):
    raw = default_schedule(UNITS)
    raw.update({"enabled": True, **overrides})
    return validate_schedule(raw, UNITS)


class MemoryStore:
    """ScheduleStore stand-in holding a validated document."""

    def __init__(self, raw):
        self.document = raw

    def snapshot(self):
        return self.document

    def enabled(self):
        return self.document["enabled"]


class Clock:
    def __init__(self, when):
        self.when = when

    def __call__(self):
        return self.when


class ValidationTests(unittest.TestCase):
    def test_default_is_valid_and_disabled(self):
        raw = default_schedule(UNITS)
        self.assertEqual(raw, validate_schedule(raw, UNITS))
        self.assertFalse(raw["enabled"])
        self.assertEqual([{"unitId": i, "speed": "max", "direction": "cw"} for i in range(1, 6)], raw["motors"])

    def test_normalizes_order(self):
        raw = default_schedule(UNITS)
        raw["motors"] = list(reversed(raw["motors"]))
        raw["daily"] = [{"start": "20:00", "end": "24:00"}, {"start": "09:00", "end": "12:00"}]
        raw["dates"] = [{"date": "2026-12-01", "windows": []},
                        {"date": "2026-11-05", "windows": [{"start": "14:00", "end": "21:00"}]}]
        result = validate_schedule(raw, UNITS)
        self.assertEqual([1, 2, 3, 4, 5], [motor["unitId"] for motor in result["motors"]])
        self.assertEqual(["09:00", "20:00"], [window["start"] for window in result["daily"]])
        self.assertEqual(["2026-11-05", "2026-12-01"], [entry["date"] for entry in result["dates"]])

    def test_rejects_invalid_documents(self):
        def changed(**fields):
            raw = default_schedule(UNITS)
            raw.update(fields)
            return raw

        motors = default_schedule(UNITS)["motors"]
        cases = [
            ({**default_schedule(UNITS), "extra": 1}, "exactly"),
            (changed(schemaVersion=2), "schemaVersion"),
            (changed(enabled=1), "enabled"),
            (changed(restMinutes=241), "restMinutes"),
            (changed(restMinutes=1.5), "restMinutes"),
            (changed(spinUpSeconds=31), "spinUpSeconds"),
            (changed(spinUpSeconds=True), "spinUpSeconds"),
            (changed(endFadeSeconds=-1), "endFadeSeconds"),
            (changed(motors=motors[:4]), "all 5 units"),
            (changed(motors=[*motors[:4], {**motors[0]}]), "distinct"),
            (changed(motors=[{**motors[0], "speed": "stop"}, *motors[1:]]), "speed"),
            (changed(motors=[{**motors[0], "direction": "left"}, *motors[1:]]), "direction"),
            (changed(daily=[{"start": "18:00", "end": "18:00"}]), "end after"),
            (changed(daily=[{"start": "22:00", "end": "02:00"}]), "end after"),
            (changed(daily=[{"start": "24:00", "end": "24:00"}]), "HH:MM"),
            (changed(daily=[{"start": "8:00", "end": "09:00"}]), "HH:MM"),
            (changed(daily=[{"start": "18:00", "end": "20:00"}, {"start": "19:30", "end": "21:00"}]), "overlap"),
            (changed(daily=[{"start": "00:00", "end": "01:00"}] * 9), "at most"),
            (changed(dates=[{"date": "2026-11-5", "windows": []}]), "YYYY-MM-DD"),
            (changed(dates=[{"date": "2026-02-30", "windows": []}]), "YYYY-MM-DD"),
            (changed(dates=[{"date": "2026-11-05", "windows": []}] * 2), "twice"),
            (changed(dates=[{"date": "2026-11-05"}]), "date and windows"),
        ]
        for raw, message in cases:
            with self.subTest(message=message, raw=raw):
                with self.assertRaisesRegex(ValueError, message):
                    validate_schedule(raw, UNITS)

    def test_adjacent_windows_are_allowed(self):
        raw = document(daily=[{"start": "18:00", "end": "19:00"}, {"start": "19:00", "end": "20:00"}])
        self.assertEqual(2, len(raw["daily"]))


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.document = document(
            daily=[{"start": "18:00", "end": "20:00"}],
            dates=[{"date": "2026-11-05", "windows": [{"start": "14:00", "end": "21:00"}]},
                   {"date": "2026-11-10", "windows": []}],
        )

    def test_special_date_replaces_daily(self):
        self.assertEqual([(datetime(2026, 11, 4, 18), datetime(2026, 11, 4, 20))],
                         windows_on(self.document, date(2026, 11, 4)))
        self.assertEqual([(datetime(2026, 11, 5, 14), datetime(2026, 11, 5, 21))],
                         windows_on(self.document, date(2026, 11, 5)))
        self.assertEqual([], windows_on(self.document, date(2026, 11, 10)))

    def test_start_inclusive_end_exclusive(self):
        self.assertIsNone(current_window(self.document, datetime(2026, 11, 4, 17, 59, 59)))
        self.assertIsNotNone(current_window(self.document, datetime(2026, 11, 4, 18)))
        self.assertIsNotNone(current_window(self.document, datetime(2026, 11, 4, 19, 59, 59)))
        self.assertIsNone(current_window(self.document, datetime(2026, 11, 4, 20)))
        self.assertIsNotNone(current_window(self.document, datetime(2026, 11, 5, 15)))
        self.assertIsNone(current_window(self.document, datetime(2026, 11, 5, 21, 30)))
        self.assertIsNone(current_window(self.document, datetime(2026, 11, 10, 19)))

    def test_adjacent_and_overnight_windows_merge(self):
        raw = document(daily=[{"start": "18:00", "end": "19:00"}, {"start": "19:00", "end": "20:00"}])
        self.assertEqual((datetime(2026, 11, 4, 18), datetime(2026, 11, 4, 20)),
                         current_window(raw, datetime(2026, 11, 4, 18, 30)))
        overnight = document(daily=[{"start": "00:00", "end": "02:00"}, {"start": "22:00", "end": "24:00"}])
        self.assertEqual((datetime(2026, 11, 4, 22), datetime(2026, 11, 5, 2)),
                         current_window(overnight, datetime(2026, 11, 4, 23)))
        self.assertEqual(datetime(2026, 11, 5, 22), next_show(overnight, datetime(2026, 11, 5, 1)))

    def test_next_show(self):
        self.assertEqual(datetime(2026, 11, 4, 18), next_show(self.document, datetime(2026, 11, 4, 12)))
        self.assertEqual(datetime(2026, 11, 5, 14), next_show(self.document, datetime(2026, 11, 4, 18, 30)))
        self.assertEqual(datetime(2026, 11, 11, 18), next_show(self.document, datetime(2026, 11, 9, 21)))
        self.assertIsNone(next_show(document(daily=[], dates=[]), datetime(2026, 11, 4, 12)))
        merged = document(daily=[{"start": "18:00", "end": "19:00"}, {"start": "19:00", "end": "20:00"}])
        self.assertEqual(datetime(2026, 11, 5, 18), next_show(merged, datetime(2026, 11, 4, 18, 30)))


class Run:
    """Drives a Scheduler like output.stream: playback restarts when the scheduler says so."""

    FPS = 4

    def __init__(self, raw, when, round_frames=8):
        self.store = MemoryStore(raw)
        self.clock = Clock(when)
        self.scheduler = Scheduler(self.store, self.FPS, UNITS, now=self.clock, clock=lambda: 0.0)
        self.round_frames = round_frames
        self.playback = 0
        self.frames = []

    def step(self, count=1):
        for _ in range(count):
            frame = self.scheduler.advance(1 if self.frames else 0, self.round_frames, self.playback)
            if frame.restart:
                self.playback = 0
            self.frames.append((frame, self.playback))
            self.playback += 1
        return self.frames[-1][0]

    def phases(self, start=0):
        return [frame.phase for frame, _ in self.frames[start:]]


SHOW = datetime(2026, 11, 4, 18, 30)
OUTSIDE = datetime(2026, 11, 4, 12)
MAX_CW = (("max", "cw"),) * UNITS
STOP_CW = (("stop", "cw"),) * UNITS


class SchedulerTests(unittest.TestCase):
    def test_disabled_passes_through(self):
        run = Run(document(enabled=False), SHOW)
        frame = run.step()
        self.assertEqual(("disabled", None, 1.0, False, False),
                         (frame.phase, frame.motors, frame.light, frame.restart, frame.blackout))
        self.assertIsNone(run.scheduler.effective_motors())

    def test_full_cycle(self):
        # spin-up 1 s = 4 frames, round 8 frames, rest 1 min = 240 frames.
        run = Run(document(restMinutes=1, spinUpSeconds=1, endFadeSeconds=1), SHOW)
        run.step(4)
        self.assertEqual(["spinup"] * 4, run.phases())
        for frame, _ in run.frames:
            self.assertEqual((MAX_CW, 0.0, False), (frame.motors, frame.light, frame.restart))  # dark spin-up
        frame = run.step()
        self.assertEqual(("play", True, 1.0, MAX_CW), (frame.phase, frame.restart, frame.light, frame.motors))
        self.assertEqual(0, run.frames[-1][1])
        run.step(7)
        self.assertEqual(["play"] * 8, run.phases(4))
        frame = run.step()
        self.assertEqual(("rest", STOP_CW, 1.0, False), (frame.phase, frame.motors, frame.light, frame.restart))
        self.assertEqual(8, run.frames[-1][1])  # lights keep playing past the round
        run.step(239)
        self.assertEqual(["rest"] * 240, run.phases(12))
        frame = run.step()
        self.assertEqual(("spinup", MAX_CW, 1.0), (frame.phase, frame.motors, frame.light))  # lit spin-up
        run.step(3)
        self.assertEqual(["spinup"] * 4, run.phases(252))
        frame = run.step()
        self.assertEqual(("play", True), (frame.phase, frame.restart))
        self.assertEqual({"enabled": True, "phase": "play", "round": 2}, run.scheduler.summary())

    def test_motor_directions_follow_schedule(self):
        raw = document(restMinutes=1, spinUpSeconds=0)
        raw["motors"][1] = {"unitId": 2, "speed": "mid", "direction": "ccw"}
        run = Run(raw, SHOW)
        frame = run.step()
        self.assertEqual(("play", ("mid", "ccw")), (frame.phase, frame.motors[1]))
        run.step(8)
        self.assertEqual(("rest", ("stop", "ccw")), (run.frames[-1][0].phase, run.frames[-1][0].motors[1]))

    def test_zero_rest_replays_without_spin_up(self):
        run = Run(document(restMinutes=0, spinUpSeconds=1), SHOW)
        run.step(4 + 8)
        frame = run.step()
        self.assertEqual(("play", True, MAX_CW), (frame.phase, frame.restart, frame.motors))
        self.assertEqual(2, run.scheduler.summary()["round"])

    def test_zero_spin_up_plays_immediately(self):
        run = Run(document(spinUpSeconds=0), SHOW)
        frame = run.step()
        self.assertEqual(("play", True), (frame.phase, frame.restart))

    def test_outside_window_is_blackout(self):
        run = Run(document(), OUTSIDE)
        frame = run.step()
        self.assertEqual(("off", True, 0.0, STOP_CW), (frame.phase, frame.blackout, frame.light, frame.motors))

    def test_window_start_spins_up_dark(self):
        run = Run(document(spinUpSeconds=1), OUTSIDE)
        run.step(3)
        run.clock.when = SHOW
        frame = run.step()
        self.assertEqual(("spinup", 0.0, MAX_CW, False), (frame.phase, frame.light, frame.motors, frame.blackout))

    def test_window_end_stops_motors_and_fades(self):
        for setup in (2, 4 + 3, 4 + 8 + 10):  # during spin-up, play and rest
            with self.subTest(setup=setup):
                run = Run(document(restMinutes=1, spinUpSeconds=1, endFadeSeconds=1), SHOW)
                run.step(setup)
                lit = run.frames[-1][0].light
                run.clock.when = datetime(2026, 11, 4, 20)
                run.step(4)
                frames = [frame for frame, _ in run.frames[-4:]]
                self.assertEqual(["ending"] * 4, [frame.phase for frame in frames])
                self.assertTrue(all(frame.motors == STOP_CW for frame in frames))
                self.assertEqual([lit * 0.75, lit * 0.5, lit * 0.25, 0.0], [frame.light for frame in frames])
                frame = run.step()
                self.assertEqual(("off", True), (frame.phase, frame.blackout))

    def test_dark_spin_up_ends_dark(self):
        run = Run(document(spinUpSeconds=1, endFadeSeconds=1), SHOW)
        run.step(2)
        run.clock.when = datetime(2026, 11, 4, 20)
        self.assertEqual(0.0, run.step().light)

    def test_window_returns_during_fade(self):
        run = Run(document(spinUpSeconds=1, endFadeSeconds=1), SHOW)
        run.step(6)
        run.clock.when = datetime(2026, 11, 4, 20)
        run.step(2)
        run.clock.when = SHOW
        frame = run.step()
        self.assertEqual(("spinup", 0.0), (frame.phase, frame.light))

    def test_zero_fade_goes_off_at_once(self):
        run = Run(document(spinUpSeconds=0, endFadeSeconds=0), SHOW)
        run.step(2)
        run.clock.when = datetime(2026, 11, 4, 20)
        self.assertEqual("off", run.step().phase)

    def test_enabling_mid_window_starts_with_spin_up(self):
        run = Run(document(enabled=False, spinUpSeconds=1), SHOW)
        run.step(3)
        run.store.document = document(spinUpSeconds=1)
        frame = run.step()
        self.assertEqual(("spinup", 0.0), (frame.phase, frame.light))
        run.step(4)
        self.assertEqual(("play", 1), (run.frames[-1][0].phase, run.scheduler.summary()["round"]))

    def test_status(self):
        run = Run(document(restMinutes=1, spinUpSeconds=1), SHOW)
        status = run.scheduler.status()
        self.assertEqual((False, None, "2026-11-04T18:00"), (status["running"], status["phase"], status["window"]["start"]))
        run.step(5)
        status = run.scheduler.status()
        self.assertEqual(("play", 1, True), (status["phase"], status["round"], status["running"]))
        self.assertEqual((SHOW + timedelta(seconds=8 / 4)).isoformat(timespec="seconds"), status["phaseEndsAt"])
        self.assertEqual([{"start": "18:00", "end": "20:00"}], status["today"])
        self.assertEqual("2026-11-05T18:00", status["nextShowAt"])
        run.scheduler.stop()
        self.assertFalse(run.scheduler.status()["running"])
        self.assertEqual("disabled", Run(document(enabled=False), SHOW).scheduler.status()["phase"])


class FakeClient:
    def __init__(self, ip, universe, *_args, **_kwargs):
        self.ip = ip
        self.packets = []

    def set_simplified(self, _value): pass
    def set_net(self, _value): pass
    def set_subnet(self, _value): pass

    def send(self, payload):
        self.packets.append(payload)

    def close(self): pass


class StreamTests(unittest.TestCase):
    def run_stream(self, scheduler, frames, *, on_frame=None, motor_provider=None, unit_colors=None):
        config = longn_config(targets=[{"unit_id": 1, "ip": "127.0.0.1", "universes": [0]}])
        preset = validate_preset(default_preset("full-on"), config["pixels"])
        clients = []
        now = [0.0]

        def factory(*args, **kwargs):
            clients.append(FakeClient(*args, **kwargs))
            return clients[-1]

        def sleep(seconds):
            now[0] += seconds
            if on_frame is not None:
                on_frame(len(clients[0].packets))

        stream(config, preset, seconds=frames / 40, client_factory=factory, clock=lambda: now[0], sleep=sleep,
               motor_provider=motor_provider, scheduler=scheduler, unit_colors_provider=unit_colors)
        return config, preset, clients[0].packets[:frames]

    def payload(self, config, preset, frame, *, speed, light=1.0):
        pixels = render_frame(preset, {"unitId": 1, "logicalPixelCount": config["pixels"], "frameOffset": 0,
                                       "virtualPhaseRadians": 0.0}, frame, unit_count=5, fps=40, rpm=0)
        pixels = [(r * light, g * light, b * light) for r, g, b in pixels]
        return build_payload(pixels, hardware=config["hardware"], motor=config["motor"], speed=speed,
                             direction="cw", moon_correction=config["hardware"]["moon_correction"])

    def test_disabled_scheduler_matches_no_scheduler(self):
        motors = lambda: (("mid", "ccw"),) * 5
        scheduler = Scheduler(MemoryStore(document(enabled=False)), 40, 5, now=Clock(SHOW))
        _, _, with_scheduler = self.run_stream(scheduler, 6, motor_provider=motors)
        _, _, without = self.run_stream(None, 6, motor_provider=motors)
        self.assertEqual(without, with_scheduler)

    def test_off_sends_all_zero_but_unit_test_still_shows(self):
        scheduler = Scheduler(MemoryStore(document()), 40, 5, now=Clock(OUTSIDE))
        _, _, packets = self.run_stream(scheduler, 3)
        self.assertEqual([blackout_payload()] * 3, packets)
        _, _, tested = self.run_stream(Scheduler(MemoryStore(document()), 40, 5, now=Clock(OUTSIDE)), 2,
                                       unit_colors=lambda: [(1.0, 0.0, 0.0)] + [None] * 4)
        self.assertNotEqual(blackout_payload(), tested[0])
        self.assertEqual(0, tested[0][456])  # motor still stopped

    def test_spin_up_dark_then_play_from_frame_zero(self):
        scheduler = Scheduler(MemoryStore(document(spinUpSeconds=0.05)), 40, 5, now=Clock(SHOW))  # 2 frames
        config, preset, packets = self.run_stream(scheduler, 5)
        dark = build_payload([(0.0, 0.0, 0.0)] * 152, hardware=config["hardware"], motor=config["motor"],
                             speed="max", direction="cw", moon_correction=True)
        self.assertEqual([dark, dark], packets[:2])
        self.assertEqual([self.payload(config, preset, frame, speed="max") for frame in range(3)], packets[2:])

    def test_window_end_fades_with_motors_stopped(self):
        clock = Clock(SHOW)
        scheduler = Scheduler(MemoryStore(document(spinUpSeconds=0, endFadeSeconds=0.1)), 40, 5, now=clock)

        def on_frame(sent):
            if sent == 2:
                clock.when = datetime(2026, 11, 4, 20)

        config, preset, packets = self.run_stream(scheduler, 7, on_frame=on_frame)
        self.assertEqual([self.payload(config, preset, frame, speed="max") for frame in range(2)], packets[:2])
        self.assertEqual([self.payload(config, preset, frame, speed="stop", light=light)
                          for frame, light in ((2, 0.75), (3, 0.5), (4, 0.25))], packets[2:5])
        self.assertEqual([blackout_payload()] * 2, packets[5:])


def write_config(directory, render_extra=""):
    path = Path(directory)
    (path / "preset.json").write_text(json.dumps(default_preset("full-on")), encoding="utf-8")
    (path / "config.toml").write_text(
        '[artnet]\nip = "127.0.0.1"\n[render]\npreset = "preset.json"\n' + render_extra, encoding="utf-8")
    return path / "config.toml"


class StoreAndConfigTests(unittest.TestCase):
    def test_config_schedule_path(self):
        with tempfile.TemporaryDirectory() as directory:
            config, _ = load_config(write_config(directory))
            self.assertEqual(str((Path(directory) / "schedule.json").resolve()), config["schedule_path"])
            config, _ = load_config(write_config(directory, 'sequence = "preset/sequence.json"\n'))
            self.assertEqual(str((Path(directory) / "preset" / "schedule.json").resolve()), config["schedule_path"])
            config, _ = load_config(write_config(directory, 'schedule = "show.json"\n'))
            self.assertTrue(config["schedule_path"].endswith("show.json"))
            with self.assertRaisesRegex(ValueError, "render.schedule"):
                load_config(write_config(directory, 'schedule = ""\n'))

    def test_store_defaults_until_saved_and_persists(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "schedule.json"
            store = ScheduleStore(path, UNITS)
            self.assertFalse(store.enabled())
            self.assertFalse(path.exists())
            raw = document(restMinutes=7)
            state = store.apply(raw)
            self.assertEqual((1, 7), (state["revision"], state["schedule"]["restMinutes"]))
            self.assertEqual(raw, ScheduleStore(path, UNITS).snapshot())
            with self.assertRaises(ValueError):
                store.apply({**raw, "restMinutes": -1})
            self.assertEqual(7, json.loads(path.read_text(encoding="utf-8"))["restMinutes"])
            self.assertEqual([], [name for name in Path(directory).iterdir() if name.name.startswith(".schedule-")])

    def test_sequence_loop_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SequenceStore(Path(directory) / "sequence.json", 152, 40, 5, default_preset("full-on"))
            self.assertEqual("hold", store.snapshot()[1][0]["ending"]["kind"])
            self.assertEqual("loop", store.snapshot(loop=True)[1][0]["ending"]["kind"])
            self.assertEqual(store.snapshot()[2], store.snapshot(loop=True)[2])


class ApiTests(unittest.TestCase):
    def test_schedule_api_and_motor_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            config = longn_config()
            preset_path = Path(directory) / "preset.json"
            preset_path.write_text(json.dumps(default_preset("full-on")), encoding="utf-8")
            schedule_store = ScheduleStore(Path(directory) / "schedule.json", UNITS)
            scheduler = Scheduler(schedule_store, 40, UNITS, now=Clock(SHOW))
            motor_store = MotorStore(DEFAULT_MOTOR, UNITS)
            server = make_server(PresetStore(preset_path, 152), config, 0, motor_store=motor_store,
                                 schedule_store=schedule_store, scheduler=scheduler)
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"

            def put(path, body):
                request = Request(base + path, json.dumps(body).encode(), {"Content-Type": "application/json"},
                                  method="PUT")
                with urlopen(request) as response:
                    return json.load(response)

            try:
                with urlopen(base + "/api/schedule") as response:
                    state = json.load(response)
                self.assertEqual((False, "disabled"), (state["schedule"]["enabled"], state["status"]["phase"]))
                put("/api/motor", {"speed": "mid"})  # allowed while disabled
                saved = put("/api/schedule", document())
                self.assertEqual((1, True), (saved["revision"], saved["schedule"]["enabled"]))
                self.assertTrue((Path(directory) / "schedule.json").exists())
                with self.assertRaises(HTTPError) as conflict:
                    put("/api/motor", {"speed": "stop"})
                self.assertEqual(409, conflict.exception.code)
                self.assertEqual((("mid", "cw"),) * 5, motor_store.snapshot())
                with self.assertRaises(HTTPError) as invalid:
                    put("/api/schedule", {**document(), "restMinutes": 999})
                self.assertEqual(422, invalid.exception.code)
                with urlopen(base + "/api/state") as response:
                    self.assertEqual({"enabled": True, "phase": None, "round": None}, json.load(response)["schedule"])
            finally:
                server.shutdown()
                worker.join(timeout=2)
                server.server_close()


if __name__ == "__main__":
    unittest.main()
