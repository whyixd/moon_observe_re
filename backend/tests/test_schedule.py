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
from moon_observe_backend.hardware import build_payload
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
            (changed(schemaVersion=3), "schemaVersion"),
            (changed(schemaVersion=1), "schemaVersion"),  # v1 needs its legacy fields to be recognised
            ({**default_schedule(UNITS), "restMinutes": 10}, "exactly"),
            (changed(enabled=1), "enabled"),
            (changed(spinUpSeconds=31), "spinUpSeconds"),
            (changed(spinUpSeconds=-1), "spinUpSeconds"),
            (changed(spinUpSeconds=True), "spinUpSeconds"),
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

    def test_reads_v1_documents(self):
        v1 = {**default_schedule(UNITS), "schemaVersion": 1, "restMinutes": 10, "endFadeSeconds": 3, "enabled": True}
        result = validate_schedule(v1, UNITS)
        self.assertEqual(document(), result)
        self.assertEqual(2, result["schemaVersion"])
        self.assertNotIn("restMinutes", result)

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
    """Drives a Scheduler like output.stream: one frame per step, wall clock and playback advance together."""

    FPS = 4

    def __init__(self, raw, when, round_frames=8, playback=0):
        self.store = MemoryStore(raw)
        self.clock = Clock(when)
        self.scheduler = Scheduler(self.store, self.FPS, UNITS, now=self.clock, clock=lambda: 0.0)
        self.round_frames = round_frames
        self.playback = playback
        self.frames = []

    def step(self, count=1):
        for _ in range(count):
            self.frames.append(self.scheduler.advance(self.round_frames, self.playback))
            self.playback += 1
            self.clock.when += timedelta(seconds=1 / self.FPS)
        return self.frames[-1]

    def phases(self, start=0):
        return [frame.phase for frame in self.frames[start:]]


SHOW = datetime(2026, 11, 4, 18, 30)
OUTSIDE = datetime(2026, 11, 4, 12)
MAX_CW = (("max", "cw"),) * UNITS
STOP_CW = (("stop", "cw"),) * UNITS


def at(hour, minute, second=0.0):
    return datetime(2026, 11, 4, hour, minute) + timedelta(seconds=second)


class SchedulerTests(unittest.TestCase):
    def test_disabled_passes_through(self):
        run = Run(document(enabled=False), SHOW)
        self.assertEqual(("disabled", None), (run.step().phase, run.step().motors))
        self.assertIsNone(run.scheduler.effective_motors())
        self.assertEqual({"enabled": False, "phase": "disabled"}, run.scheduler.summary())

    def test_outside_window_stops_motors_only(self):
        frame = Run(document(), OUTSIDE).step()
        self.assertEqual(("off", STOP_CW), (frame.phase, frame.motors))

    def test_motors_start_before_the_round_covering_the_window_start(self):
        # Round = 8 frames (2 s); playback 3 at 17:59:50 → rounds start at …:59:49.25 + 2k s, so the round
        # covering 18:00 starts at 17:59:59.25 and the motors start 1 s earlier (17:59:58.25, step 33).
        run = Run(document(spinUpSeconds=1), at(17, 59, 50), playback=3)
        run.step(33)
        self.assertEqual(["off"] * 33, run.phases())
        frame = run.step()
        self.assertEqual(("spinup", MAX_CW), (frame.phase, frame.motors))
        run.step(3)
        self.assertEqual(["spinup"] * 4, run.phases(33))
        run.step(20)  # 17:59:59.25 onwards: the round has started; 18:00 is inside the window
        self.assertEqual(["run"] * 20, run.phases(37))
        self.assertTrue(all(frame.motors == MAX_CW for frame in run.frames[33:]))

    def test_window_start_on_a_round_boundary(self):
        # Rounds start at 17:59:50 + 2k s, one exactly at 18:00: that is the covering round.
        run = Run(document(spinUpSeconds=0.5), at(17, 59, 50))
        run.step(38)
        self.assertEqual("off", run.frames[-1].phase)
        self.assertEqual(["spinup", "spinup", "run"], [run.step().phase for _ in range(3)])

    def test_window_end_finishes_the_round(self):
        run = Run(document(spinUpSeconds=0), at(19, 59, 59))  # rounds at 19:59:59 and 20:00:01
        run.step(4)
        self.assertEqual(["run"] * 4, run.phases())
        run.step(4)  # 20:00:00 – 20:00:00.75, still the round that began at 19:59:59
        self.assertEqual(["finishing"] * 4, run.phases(4))
        self.assertTrue(all(frame.motors == MAX_CW for frame in run.frames[4:]))
        frame = run.step()
        self.assertEqual(("off", STOP_CW), (frame.phase, frame.motors))

    def test_window_end_on_a_round_boundary_stops_at_once(self):
        run = Run(document(spinUpSeconds=0), at(19, 59, 58))
        run.step(8)
        self.assertEqual("off", run.step().phase)

    def test_mid_window_start_spins_at_once(self):
        run = Run(document(enabled=False), SHOW, playback=5)
        run.step()
        run.store.document = document()
        frame = run.step()
        self.assertEqual(("run", MAX_CW), (frame.phase, frame.motors))

    def test_enabling_after_the_covering_round_began(self):
        # The covering round began at 17:59:59.25; enabling at 17:59:59.5 spins at once.
        run = Run(document(spinUpSeconds=0), at(17, 59, 59.5), playback=1)
        self.assertEqual(("run", MAX_CW), (run.step().phase, run.frames[-1].motors))

    def test_playback_restart_keeps_spinning_motors_on(self):
        run = Run(document(spinUpSeconds=1), at(17, 59, 58.25), playback=4)  # spin-up starts now
        self.assertEqual("spinup", run.step().phase)
        run.playback = 2  # e.g. a sequence edit: the covering round now starts 1.5 s away, past the spin-up
        self.assertEqual(("spinup", MAX_CW), (run.step().phase, run.frames[-1].motors))
        run.playback = 0  # restarting exactly now: this is the round covering 18:00
        self.assertEqual("run", run.step().phase)

    def test_next_window_close_after_the_end_keeps_spinning(self):
        raw = document(spinUpSeconds=5, daily=[{"start": "18:00", "end": "19:00"}, {"start": "19:02", "end": "20:00"}])
        run = Run(raw, at(18, 59, 59.75), round_frames=4 * 240)  # 4-minute rounds, the current one began 18:58:30
        run.playback = 4 * 89 + 3
        self.assertEqual(["run", "run"], [run.step().phase for _ in range(2)])  # 19:00 → the 19:02 window's round
        self.assertEqual("2026-11-04T19:02", run.scheduler.status()["window"]["start"])

    def test_special_date_without_windows_never_spins(self):
        raw = document(dates=[{"date": "2026-11-04", "windows": []}])
        run = Run(raw, SHOW)
        self.assertEqual(("off", STOP_CW), (run.step().phase, run.frames[-1].motors))

    def test_motor_directions_follow_schedule(self):
        raw = document(spinUpSeconds=0)
        raw["motors"][1] = {"unitId": 2, "speed": "mid", "direction": "ccw"}
        self.assertEqual(("mid", "ccw"), Run(raw, SHOW).step().motors[1])
        self.assertEqual(("stop", "ccw"), Run(raw, OUTSIDE).step().motors[1])

    def test_status(self):
        run = Run(document(spinUpSeconds=1), at(17, 59, 50), playback=3)
        status = run.scheduler.status()
        self.assertEqual((False, None, None), (status["running"], status["phase"], status["window"]))
        run.step()
        status = run.scheduler.status()
        self.assertEqual(("off", True, None), (status["phase"], status["running"], status["phaseEndsAt"]))
        self.assertEqual("2026-11-04T17:59:58", status["motorStartAt"])  # 17:59:58.25 at the time of the frame
        self.assertEqual("2026-11-04T18:00", status["nextShowAt"])
        run.step(33)
        status = run.scheduler.status()
        self.assertEqual(("spinup", "2026-11-04T18:00", None), (status["phase"], status["window"]["start"], status["motorStartAt"]))
        self.assertEqual("2026-11-04T17:59:59", status["phaseEndsAt"])
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

    def payload(self, config, preset, frame, *, speed):
        pixels = render_frame(preset, {"unitId": 1, "logicalPixelCount": config["pixels"], "frameOffset": 0,
                                       "virtualPhaseRadians": 0.0}, frame, unit_count=5, fps=40, rpm=0)
        return build_payload(pixels, hardware=config["hardware"], motor=config["motor"], speed=speed,
                             direction="cw", moon_correction=config["hardware"]["moon_correction"])

    def test_disabled_scheduler_matches_no_scheduler(self):
        motors = lambda: (("mid", "ccw"),) * 5
        scheduler = Scheduler(MemoryStore(document(enabled=False)), 40, 5, now=Clock(SHOW))
        _, _, with_scheduler = self.run_stream(scheduler, 6, motor_provider=motors)
        _, _, without = self.run_stream(None, 6, motor_provider=motors)
        self.assertEqual(without, with_scheduler)

    def test_lights_play_unchanged_and_only_motors_follow_the_window(self):
        for when, speed in ((SHOW, "max"), (OUTSIDE, "stop")):
            with self.subTest(speed=speed):
                scheduler = Scheduler(MemoryStore(document()), 40, 5, now=Clock(when))
                config, preset, packets = self.run_stream(scheduler, 4, motor_provider=lambda: (("mid", "cw"),) * 5)
                self.assertEqual([self.payload(config, preset, frame, speed=speed) for frame in range(4)], packets)


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
            raw = document(spinUpSeconds=7)
            state = store.apply(raw)
            self.assertEqual((1, 7), (state["revision"], state["schedule"]["spinUpSeconds"]))
            self.assertEqual(raw, ScheduleStore(path, UNITS).snapshot())
            with self.assertRaises(ValueError):
                store.apply({**raw, "spinUpSeconds": -1})
            self.assertEqual(7, json.loads(path.read_text(encoding="utf-8"))["spinUpSeconds"])
            self.assertEqual([], [name for name in Path(directory).iterdir() if name.name.startswith(".schedule-")])

    def test_store_reads_a_v1_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "schedule.json"
            v1 = {**document(), "schemaVersion": 1, "restMinutes": 10, "endFadeSeconds": 3}
            path.write_text(json.dumps(v1), encoding="utf-8")
            self.assertEqual(document(), ScheduleStore(path, UNITS).snapshot())

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
                    put("/api/schedule", {**document(), "spinUpSeconds": 999})
                self.assertEqual(422, invalid.exception.code)
                with urlopen(base + "/api/state") as response:
                    self.assertEqual({"enabled": True, "phase": None}, json.load(response)["schedule"])
            finally:
                server.shutdown()
                worker.join(timeout=2)
                server.server_close()


if __name__ == "__main__":
    unittest.main()
