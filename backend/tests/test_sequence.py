import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from moon_observe_backend.control import PresetStore, make_server
from moon_observe_backend.effects import default_preset
from moon_observe_backend.output import stream
from moon_observe_backend.renderer import render_frame, rgb_bytes
from moon_observe_backend.sequence import (
    SequenceStore, _layer_details, compile_sequence, render_sequence_frame, sequence_layers, unit_fade_weight,
    validate_sequence,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "effects_v2.json"

CONFIG = {
    "ip": "127.0.0.1", "source_ip": None, "universe": 0,
    "fps": 40, "rpm": 360, "pixels": 156, "unit_id": 1, "unit_count": 9,
}
UNIT = {"unitId": 1, "logicalPixelCount": 156, "frameOffset": 0}


def document():
    return {
        "schemaVersion": 1,
        "ending": {"kind": "hold"},
        "steps": [
            {"id": 1, "preset": default_preset("spectrum-cycle"),
             "playback": {"kind": "count", "count": 2},
             "transition": {"kind": "crossfade", "seconds": 0.1}},
            {"id": 2, "preset": default_preset("random-leds"),
             "playback": {"kind": "time", "seconds": 1},
             "transition": {"kind": "cut", "seconds": 0.5}},
        ],
    }


class FakeClient:
    def __init__(self, *_args, **_kwargs):
        self.packets = []

    def set_simplified(self, _value): pass
    def set_net(self, _value): pass
    def set_subnet(self, _value): pass
    def send(self, payload): self.packets.append(payload)
    def close(self): pass


class SequenceTests(unittest.TestCase):
    def test_phase_free_effect_completion_boundaries(self):
        expected = {
            "reverse-tide": 292,  # four stages of a 53-frame move + 20-frame hold
            "wide-rings": 200,
            "comet-tail": 160,
            "sector-smear": 8,
            "twenty-beat": 20,
        }
        for effect_id, frames in expected.items():
            raw = document()
            raw["steps"][0]["preset"] = default_preset(effect_id)
            raw["steps"][0]["playback"] = {"kind": "count", "count": 1}
            self.assertEqual(frames, compile_sequence(raw, 40, 9)[0]["duration"], effect_id)
        for effect_id in ("stardust-cloud", "color-breathing"):
            raw = document()
            raw["steps"][0]["preset"] = default_preset(effect_id)
            with self.assertRaisesRegex(ValueError, "completion boundary"):
                validate_sequence(raw)
    def test_unit_variation_step_counts_by_longest_unit_cycle(self):
        raw = document()
        preset = default_preset("sine-swell")
        preset["unitVariation"] = {"parameter": "speedHz", "from": 0.2, "to": 1, "distribution": "skip"}
        raw["steps"][0]["preset"] = preset
        self.assertEqual(preset, validate_sequence(raw)["steps"][0]["preset"])
        # Slowest unit runs 0.2 Hz: 200 frames per repeat, two repeats.
        self.assertEqual(400, compile_sequence(raw, 40, 9)[0]["duration"])

    def test_unit_fade_black_matches_frontend_weights(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))["unitFade"]
        schedule = compile_sequence(fixture["sequence"], 40, 9)
        for case in fixture["frames"]:
            actual = [
                [weight * (unit_fade_weight(fade, unit, 9) if fade else 1) for unit in range(9)]
                for *_, weight, fade in _layer_details(schedule, case["frame"])
            ]
            self.assertEqual(len(case["weights"]), len(actual), case["frame"])
            for expected_layer, actual_layer in zip(case["weights"], actual):
                for expected, value in zip(expected_layer, actual_layer):
                    self.assertAlmostEqual(expected, value, places=12, msg=case["frame"])

    def test_unit_fade_black_renders_units_dark_in_order(self):
        raw = document()
        raw["steps"][0] = {"id": 1, "preset": default_preset("full-on"),
                           "playback": {"kind": "time", "seconds": 1},
                           "transition": {"kind": "unit-fade-black", "seconds": 2}}
        self.assertEqual("unit-fade-black", validate_sequence(raw)["steps"][0]["transition"]["kind"])
        schedule = compile_sequence(raw, 40, 9)

        def brightness(frame: int) -> list[float]:
            return [render_sequence_frame(schedule, {"unitId": unit, "logicalPixelCount": 4, "frameOffset": 0}, frame,
                                          unit_count=9, fps=40, rpm=360)[0][0] for unit in range(1, 10)]

        # Second step starts at frame 40 with a 40-frame transition: 20 frames of staggered fade-out.
        early = brightness(40 + 5)
        self.assertLess(early[0], 1.0)
        self.assertEqual(1.0, early[8])
        self.assertEqual(sorted(early), early)
        self.assertEqual([0.0] * 9, brightness(40 + 19))
        incoming = brightness(40 + 30)
        self.assertEqual(1, len(set(incoming)))
        self.assertGreater(incoming[0], 0)

    def test_validate_boundaries_and_frontend_transition_frames(self):
        raw = document()
        compiled = compile_sequence(raw, 40, 9)
        self.assertEqual(80, compiled[-1]["start"] + compiled[-1]["duration"])
        self.assertEqual((19, 39, 0.8), sequence_layers(compiled, 40)[0][1:])
        self.assertEqual((0, 40, 0.2), sequence_layers(compiled, 40)[1][1:])
        self.assertEqual(0, sequence_layers(compiled, 20)[0][1])
        self.assertEqual(79, sequence_layers(compiled, 80)[0][2])
        rendered = render_sequence_frame(compiled, UNIT, 40, unit_count=9, fps=40, rpm=360)
        first = render_frame(compiled[0]["preset"], UNIT, 19, phase_frame=39)
        second = render_frame(compiled[1]["preset"], UNIT, 0, phase_frame=40)
        for actual, left, right in zip(rendered, first, second):
            for channel in range(3):
                self.assertAlmostEqual(left[channel] * 0.8 + right[channel] * 0.2, actual[channel])

        raw["steps"][1]["playback"] = {"kind": "count", "count": 1}
        with self.assertRaisesRegex(ValueError, "completion boundary"):
            validate_sequence(raw)

        fade = document()
        fade["steps"][0]["playback"] = {"kind": "time", "seconds": 0.1}
        fade["steps"][0]["transition"] = {"kind": "fade-black", "seconds": 2}
        fade["steps"][1]["preset"] = default_preset("spectrum-cycle")
        fade["steps"][1]["playback"] = {"kind": "count", "count": 1}
        schedule = compile_sequence(fade, 40, 9)
        self.assertEqual(20, schedule[1]["transition_frames"])
        self.assertEqual((0.0, 0.0), tuple(layer[3] for layer in sequence_layers(schedule, 13)))

    def test_loop_uses_last_transition_and_resets_effect_frames(self):
        raw = document()
        raw["ending"] = {"kind": "loop"}
        raw["steps"][1]["transition"] = {"kind": "crossfade", "seconds": 0.05}
        raw["steps"][1]["playback"] = {"kind": "time", "seconds": 0.1}
        schedule = compile_sequence(raw, 40, 9)
        self.assertEqual(44, schedule[-1]["start"] + schedule[-1]["duration"])
        self.assertEqual(2, schedule[0]["loop_transition_frames"])
        self.assertEqual(1, len(sequence_layers(schedule, 0)))
        boundary = sequence_layers(schedule, 44)
        self.assertEqual(43, boundary[0][2])
        self.assertAlmostEqual(2 / 3, boundary[0][3])
        self.assertEqual((0, 44), boundary[1][1:3])
        self.assertAlmostEqual(1 / 3, boundary[1][3])
        self.assertEqual((2, 46, 1.0), sequence_layers(schedule, 46)[0][1:])
        self.assertEqual(87, sequence_layers(schedule, 88)[0][2])
        self.assertAlmostEqual(2 / 3, sequence_layers(schedule, 88)[0][3])

    def test_fade_to_black_and_legacy_document(self):
        legacy = document()
        legacy.pop("ending")
        self.assertEqual({"kind": "hold"}, validate_sequence(legacy)["ending"])
        raw = document()
        raw["ending"] = {"kind": "fade-black", "seconds": 0.1}
        schedule = compile_sequence(raw, 40, 9)
        total = schedule[-1]["start"] + schedule[-1]["duration"]
        self.assertEqual(4, schedule[0]["end_fade_frames"])
        self.assertEqual(1.0, sequence_layers(schedule, total - 1)[0][3])
        self.assertEqual(0.75, sequence_layers(schedule, total)[0][3])
        self.assertEqual(0.0, sequence_layers(schedule, total + 3)[0][3])
        self.assertEqual(0.0, sequence_layers(schedule, total + 20)[0][3])
        self.assertEqual([(0.0, 0.0, 0.0)] * 156,
                         render_sequence_frame(schedule, UNIT, total + 3, unit_count=9, fps=40, rpm=360))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sequence.json"
            path.write_text(json.dumps(legacy), encoding="utf-8")
            store = SequenceStore(path, 156, 40, 9, default_preset("center-out-sine"))
            self.assertEqual({"kind": "hold"}, store.state()["sequence"]["ending"])
            store.apply(raw)
            self.assertEqual(raw["ending"], json.loads(path.read_text(encoding="utf-8"))["ending"])
            reopened = SequenceStore(path, 156, 40, 9, default_preset("center-out-sine"))
            self.assertEqual(raw["ending"], reopened.state()["sequence"]["ending"])
        raw["ending"]["seconds"] = 0
        with self.assertRaisesRegex(ValueError, "ending fade seconds"):
            validate_sequence(raw)

    def test_single_runtime_file_persists_and_reloads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sequence.json"
            fallback = default_preset("center-out-sine")
            store = SequenceStore(path, 156, 40, 9, fallback)
            self.assertTrue(path.exists())
            self.assertEqual(1, len(store.state()["sequence"]["steps"]))
            self.assertEqual(1, store.apply(document())["revision"])
            saved_bytes = path.read_bytes()
            invalid = document()
            invalid["steps"][1]["playback"] = {"kind": "count", "count": 1}
            with self.assertRaises(ValueError):
                store.apply(invalid)
            self.assertEqual(saved_bytes, path.read_bytes())
            self.assertEqual(1, store.state()["revision"])
            self.assertEqual("sequence", store.snapshot()[0])
            store.use_single_preset()
            self.assertEqual("single", store.snapshot()[0])
            reopened = SequenceStore(path, 156, 40, 9, fallback)
            self.assertEqual(document(), reopened.state()["sequence"])
            self.assertEqual("sequence", reopened.snapshot()[0])
            self.assertEqual(["sequence.json"], [entry.name for entry in Path(directory).iterdir()])

    def test_api_get_save_and_switch_to_single(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preset_path = root / "preset.json"
            preset_path.write_text(json.dumps(default_preset("center-out-sine")), encoding="utf-8")
            preset_store = PresetStore(preset_path, 156)
            sequence_path = root / "sequence.json"
            sequence_store = SequenceStore(sequence_path, 156, 40, 9, preset_store.state(CONFIG)["preset"])
            with make_server(preset_store, CONFIG, 0, sequence_store=sequence_store) as server:
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    url = f"http://127.0.0.1:{server.server_address[1]}"
                    with urlopen(url + "/api/sequence") as response:
                        initial = json.load(response)
                        self.assertEqual(1, len(initial["sequence"]["steps"]))
                        self.assertEqual({"fps": 40, "rpm": 360, "unitCount": 9}, initial["output"])
                    saved = Request(url + "/api/sequence", json.dumps(document()).encode(),
                                    {"Content-Type": "application/json"}, method="PUT")
                    with urlopen(saved) as response:
                        self.assertEqual(2, len(json.load(response)["sequence"]["steps"]))
                    self.assertEqual(document(), json.loads(sequence_path.read_text(encoding="utf-8")))
                    single = Request(url + "/api/preset", json.dumps(default_preset("moving-rings")).encode(),
                                     {"Content-Type": "application/json"}, method="PUT")
                    with urlopen(single):
                        pass
                    self.assertEqual("single", sequence_store.snapshot()[0])
                    saved_bytes = sequence_path.read_bytes()
                    generation = sequence_store.snapshot()[2]
                    restart = Request(url + "/api/playback/restart", json.dumps({"source": "sequence"}).encode(),
                                      {"Content-Type": "application/json"}, method="PUT")
                    with urlopen(restart) as response:
                        self.assertEqual("sequence", json.load(response)["playbackMode"])
                    self.assertEqual(("sequence", generation + 1), sequence_store.snapshot()[::2])
                    self.assertEqual(saved_bytes, sequence_path.read_bytes())
                    invalid = Request(url + "/api/playback/restart", json.dumps({"source": "loop"}).encode(),
                                      {"Content-Type": "application/json"}, method="PUT")
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(invalid)
                    self.assertEqual(422, caught.exception.code)
                    self.assertEqual(generation + 1, sequence_store.snapshot()[2])
                finally:
                    server.shutdown()
                    worker.join(timeout=2)

    def test_restart_replays_source_without_saving(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sequence.json"
            store = SequenceStore(path, 156, 40, 9, default_preset("center-out-sine"))
            saved_bytes = path.read_bytes()
            for source in ("single", "single", "sequence"):
                generation = store.snapshot()[2]
                self.assertEqual(source, store.restart({"source": source})["playbackMode"])
                self.assertEqual((source, generation + 1), store.snapshot()[::2])
            for invalid in ({}, {"source": "loop"}, {"source": "single", "extra": 1}, ["single"]):
                with self.assertRaises(ValueError):
                    store.restart(invalid)
            self.assertEqual(saved_bytes, path.read_bytes())

    def test_stream_outputs_sequence_frames_then_holds_last(self):
        raw = document()
        raw["steps"][0]["playback"] = {"kind": "time", "seconds": 0.025}
        raw["steps"][0]["transition"] = {"kind": "cut", "seconds": 0}
        raw["steps"][1]["playback"] = {"kind": "time", "seconds": 0.025}
        compiled = compile_sequence(raw, 40, 9)
        now = [0.0]
        clients = []

        def factory(*args, **kwargs):
            client = FakeClient(*args, **kwargs)
            clients.append(client)
            return client

        def sleep(seconds):
            now[0] += seconds

        count = stream(
            CONFIG, default_preset("center-out-sine"), seconds=0.075,
            client_factory=factory, sequence_provider=lambda: ("sequence", compiled, 0),
            clock=lambda: now[0], sleep=sleep,
        )
        self.assertEqual(3, count)
        packets = clients[0].packets
        self.assertEqual(rgb_bytes(render_frame(compiled[0]["preset"], UNIT, 0)), packets[0][:468])
        self.assertEqual(rgb_bytes(render_frame(compiled[1]["preset"], UNIT, 0, phase_frame=1)), packets[1][:468])
        self.assertEqual(packets[1][:468], packets[2][:468])


if __name__ == "__main__":
    unittest.main()
