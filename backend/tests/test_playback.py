import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.request import urlopen

from moon_observe_backend.control import PresetStore, make_server
from moon_observe_backend.effects import completion_frames, default_preset, validate_preset
from moon_observe_backend.output import stream
from moon_observe_backend.playback import PlaybackMonitor
from moon_observe_backend.sequence import compile_sequence, sequence_position

CONFIG = {
    "ip": "127.0.0.1", "source_ip": None, "universe": 0,
    "fps": 40, "rpm": 360, "pixels": 156, "unit_id": 1, "unit_count": 9,
}


def document():
    # Step 1: 2 x 20-frame cycles; step 2: 40 frames entered through a 4-frame crossfade.
    return {
        "schemaVersion": 1,
        "ending": {"kind": "hold"},
        "steps": [
            {"id": 7, "preset": default_preset("spectrum-cycle"),
             "playback": {"kind": "count", "count": 2},
             "transition": {"kind": "crossfade", "seconds": 0.1}},
            {"id": 3, "preset": default_preset("random-leds"),
             "playback": {"kind": "time", "seconds": 1},
             "transition": {"kind": "cut", "seconds": 0.5}},
        ],
    }


class FakeClient:
    def __init__(self, *_args, **_kwargs): pass
    def set_simplified(self, _value): pass
    def set_net(self, _value): pass
    def set_subnet(self, _value): pass
    def send(self, _payload): pass
    def close(self): pass


class SequencePositionTests(unittest.TestCase):
    def test_steps_repeats_and_transition(self):
        schedule = compile_sequence(document(), 40, 9)
        start = sequence_position(schedule, 0)
        self.assertEqual(80, start["totalFrames"])
        self.assertEqual({"index": 0, "id": 7, "effectId": "spectrum-cycle", "elapsed": 0,
                          "duration": 40, "repeat": {"current": 1, "total": 2}}, start["step"])
        self.assertIsNone(start["transition"])
        self.assertEqual({"current": 2, "total": 2}, sequence_position(schedule, 25)["step"]["repeat"])

        entering = sequence_position(schedule, 41)
        self.assertEqual((1, 3, 1, None), tuple(entering["step"][key] for key in ("index", "id", "elapsed", "repeat")))
        self.assertEqual({"kind": "crossfade", "fromIndex": 0, "elapsed": 1, "frames": 4}, entering["transition"])
        self.assertIsNone(sequence_position(schedule, 44)["transition"])

    def test_hold_and_fade_endings(self):
        schedule = compile_sequence(document(), 40, 9)
        held = sequence_position(schedule, 100)
        self.assertTrue(held["ended"])
        self.assertEqual((80, 100), (held["sequenceFrame"], held["frame"]))
        self.assertEqual((1, 39), (held["step"]["index"], held["step"]["elapsed"]))
        self.assertIsNone(held["endFade"])
        self.assertFalse(sequence_position(schedule, 79)["ended"])

        raw = document()
        raw["ending"] = {"kind": "fade-black", "seconds": 0.1}
        schedule = compile_sequence(raw, 40, 9)
        self.assertEqual({"elapsed": 2, "frames": 4}, sequence_position(schedule, 81)["endFade"])
        self.assertEqual({"elapsed": 4, "frames": 4}, sequence_position(schedule, 200)["endFade"])

    def test_loop_counts_iterations_and_uses_last_transition(self):
        raw = document()
        raw["ending"] = {"kind": "loop"}
        raw["steps"][1]["transition"] = {"kind": "crossfade", "seconds": 0.05}
        raw["steps"][1]["playback"] = {"kind": "time", "seconds": 0.1}
        schedule = compile_sequence(raw, 40, 9)
        self.assertIsNone(sequence_position(schedule, 1)["transition"])
        wrapped = sequence_position(schedule, 45)
        self.assertEqual((2, 1, False), (wrapped["loopIteration"], wrapped["sequenceFrame"], wrapped["ended"]))
        self.assertEqual({"kind": "crossfade", "fromIndex": 1, "elapsed": 1, "frames": 2}, wrapped["transition"])


class PlaybackMonitorTests(unittest.TestCase):
    def test_inactive_until_reported_and_after_stop(self):
        now = [10.0]
        monitor = PlaybackMonitor(40, 9, clock=lambda: now[0])
        self.assertEqual({"active": False}, monitor.state())

        monitor.report("sequence", compile_sequence(document(), 40, 9), 1, 41)
        now[0] += 0.02
        state = monitor.state()
        self.assertEqual((True, "sequence", 1, 40, 20), tuple(state[key] for key in ("active", "mode", "restart", "fps", "ageMs")))
        self.assertEqual(1, state["step"]["index"])

        preset = default_preset("center-out-sine")
        cycle = completion_frames(preset, 40, 9)
        monitor.report("single", preset, 2, cycle + 3)
        single = monitor.state()
        self.assertEqual("center-out-sine", single["effectId"])
        self.assertEqual({"current": 2, "elapsed": 3, "frames": cycle}, single["cycle"])

        monitor.report("single", default_preset("random-leds"), 2, 5)
        self.assertIsNone(monitor.state()["cycle"])
        monitor.stop()
        self.assertEqual({"active": False}, monitor.state())

    def test_stream_reports_each_frame_and_restarts_on_new_generation(self):
        schedule = compile_sequence(document(), 40, 9)
        generation = [0]
        reports = []
        now = [0.0]

        def sequence_provider():
            return "sequence", schedule, generation[0]

        def reporter(mode, current, restart, frame):
            reports.append((mode, current is schedule, restart, frame))
            if len(reports) == 2:
                generation[0] = 1

        def sleep(seconds):
            now[0] += seconds

        stream(CONFIG, default_preset("center-out-sine"), seconds=0.1, client_factory=FakeClient,
               sequence_provider=sequence_provider, playback_reporter=reporter,
               clock=lambda: now[0], sleep=sleep)
        self.assertEqual([("sequence", True, 1, 0), ("sequence", True, 1, 1),
                          ("sequence", True, 2, 0), ("sequence", True, 2, 1)], reports)

    def test_stream_reports_active_single_preset(self):
        preset = validate_preset(default_preset("moving-rings"), 156)
        reports = []
        now = [0.0]

        def sleep(seconds):
            now[0] += seconds

        stream(CONFIG, default_preset("center-out-sine"), seconds=0.05, client_factory=FakeClient,
               preset_provider=lambda: preset,
               sequence_provider=lambda: ("single", (), 0),
               playback_reporter=lambda *args: reports.append(args),
               clock=lambda: now[0], sleep=sleep)
        self.assertEqual([("single", preset, 1, 0), ("single", preset, 1, 1)], reports)


class PlaybackApiTests(unittest.TestCase):
    def get_playback(self, monitor):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "preset.json"
            path.write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            with make_server(PresetStore(path, 156), CONFIG, 0, playback_monitor=monitor) as server:
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    url = f"http://127.0.0.1:{server.server_address[1]}/api/playback"
                    with urlopen(url) as response:
                        self.assertEqual("no-store", response.headers["Cache-Control"])
                        return json.load(response)
                finally:
                    server.shutdown()
                    worker.join(timeout=2)

    def test_reports_inactive_without_output_loop(self):
        self.assertEqual({"active": False}, self.get_playback(None))
        self.assertEqual({"active": False}, self.get_playback(PlaybackMonitor(40, 9)))

    def test_reports_current_sequence_position(self):
        monitor = PlaybackMonitor(40, 9)
        monitor.report("sequence", compile_sequence(document(), 40, 9), 3, 25)
        state = self.get_playback(monitor)
        self.assertEqual((True, "sequence", 3, 25), tuple(state[key] for key in ("active", "mode", "restart", "frame")))
        self.assertEqual({"current": 2, "total": 2}, state["step"]["repeat"])


if __name__ == "__main__":
    unittest.main()
