import json
import math
from pathlib import Path
import socket
import tempfile
import unittest

from stupidArtnet import StupidArtnet

from moon_observe_backend.config import load_config
from moon_observe_backend.effects import default_preset, validate_preset
from moon_observe_backend.hardware import build_payload
from moon_observe_backend.output import stream
from moon_observe_backend.renderer import render_frame
from support import longn_config


class FakeClient:
    def __init__(self, ip, universe, packet_size, **kwargs):
        self.init = (ip, universe, packet_size, kwargs)
        self.packets = []
        self.closed = False

    def set_simplified(self, value):
        self.simplified = value

    def set_net(self, value):
        self.net = value

    def set_subnet(self, value):
        self.subnet = value

    def send(self, payload):
        self.packets.append(payload)

    def close(self):
        self.closed = True


class FakeTime:
    def __init__(self):
        self.now = 0.0
        self.on_sleep = None

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.on_sleep is not None:
            self.on_sleep()


def run_stream(config, preset, seconds, **kwargs):
    clients = []
    time = kwargs.pop("time", None) or FakeTime()

    def factory(*args, **factory_kwargs):
        clients.append(FakeClient(*args, **factory_kwargs))
        return clients[-1]

    count = stream(config, validate_preset(default_preset(preset), config["pixels"]), seconds=seconds,
                   client_factory=factory, clock=time.clock, sleep=time.sleep, **kwargs)
    return count, clients


def expected_payload(config, preset_id, unit_id, frame, *, speed="stop", direction="cw", moon=None, phase=0.0):
    pixels = render_frame(
        validate_preset(default_preset(preset_id), config["pixels"]),
        {"unitId": unit_id, "logicalPixelCount": config["pixels"], "frameOffset": 0, "virtualPhaseRadians": phase},
        frame, unit_count=config["unit_count"], fps=config["fps"], rpm=0,
    )
    return build_payload(pixels, hardware=config["hardware"], motor=config["motor"], speed=speed,
                         direction=direction,
                         moon_correction=config["hardware"]["moon_correction"] if moon is None else moon)


class SendTests(unittest.TestCase):
    def test_toml_config_loads_json_preset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "preset.json").write_text(json.dumps(default_preset("random-leds")), encoding="utf-8")
            config_path = root / "config.toml"
            config_path.write_text(
                '[artnet]\nip = "192.0.2.20"\nuniverse = 0\n'
                '[render]\npreset = "preset.json"\nfps = 40\npixels = 152\nunit_id = 1\nunit_count = 5\n',
                encoding="utf-8",
            )
            config, preset = load_config(config_path)
            self.assertEqual([{"unit_id": 1, "ip": "192.0.2.20", "universes": [0]}], config["targets"])
            self.assertNotIn("universe", config)
            self.assertIsNone(config["source_ip"])
            self.assertEqual("random-leds", preset["effectId"])
            config_path.write_text(config_path.read_text(encoding="utf-8") + 'unexpected = "value"\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unknown config field"):
                load_config(config_path)

    def test_real_artdmx_on_loopback_then_blackout_twice(self):
        # 本機 UDP listener：5 格 × 2 個 universe = 10 包，接著每個 universe 兩包全 0。
        # Local UDP listener: 5 frames x 2 universes = 10 packets, then two all-zero packets per universe.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(("127.0.0.1", 0))
            receiver.settimeout(1)
            port = receiver.getsockname()[1]
            config = longn_config(targets=[{"unit_id": 1, "ip": "127.0.0.1", "universes": [0, 1]}])
            time = FakeTime()
            count = stream(
                config, validate_preset(default_preset("full-on"), 152), seconds=5 / 40,
                client_factory=lambda *args, **kwargs: StupidArtnet(*args, port=port, **kwargs),
                motor_provider=lambda: [("max", "ccw")] + [("stop", "cw")] * 4,
                clock=time.clock, sleep=time.sleep,
            )
            packets = [receiver.recvfrom(1024)[0] for _ in range(14)]
            receiver.settimeout(0.2)
            with self.assertRaises(TimeoutError):
                receiver.recvfrom(1024)
        self.assertEqual(10, count)
        for packet in packets:
            self.assertEqual(b"Art-Net\x00\x00\x50", packet[:10])
            self.assertEqual(18 + 512, len(packet))
            self.assertEqual(b"\x02\x00", packet[16:18])  # length 512, big endian
        self.assertEqual([0, 1] * 7, [packet[14] for packet in packets])  # SubUni
        frames, exit_frames = [packet[18:] for packet in packets[:10]], [packet[18:] for packet in packets[10:]]
        expected = expected_payload(config, "full-on", 1, 0, speed="max", direction="ccw")
        self.assertEqual([expected] * 10, frames)
        self.assertEqual((230, 255), tuple(frames[0][456:458]))
        self.assertEqual(round(255 * 0.4 / 15), frames[0][0])  # foot LED: brightness 0.4 x moon correction 1/15
        self.assertEqual([bytes(512)] * 4, exit_frames)

    def test_one_client_per_target_universe_with_net_and_subnet(self):
        config = longn_config(
            source_ip="192.0.2.10",
            targets=[{"unit_id": 1, "ip": "192.0.2.20", "universes": [0x1234, 0x0005]},
                     {"unit_id": 2, "ip": "192.0.2.21", "universes": [0]}],
        )
        count, clients = run_stream(config, "random-leds", 3 / 40)
        self.assertEqual(9, count)
        self.assertEqual(
            [("192.0.2.20", 4, 512, {"fps": 40, "source_address": ("192.0.2.10", 0)}),
             ("192.0.2.20", 5, 512, {"fps": 40, "source_address": ("192.0.2.10", 0)}),
             ("192.0.2.21", 0, 512, {"fps": 40, "source_address": ("192.0.2.10", 0)})],
            [client.init for client in clients],
        )
        self.assertEqual([(0x12, 3), (0, 0), (0, 0)], [(client.net, client.subnet) for client in clients])
        self.assertTrue(all(client.simplified is False and client.closed for client in clients))
        self.assertEqual(clients[0].packets, clients[1].packets)  # same frame to both universes of a unit
        self.assertNotEqual(clients[0].packets[:3], clients[2].packets[:3])
        self.assertTrue(all(len(packet) == 512 for client in clients for packet in client.packets))

    def test_payload_follows_motor_and_moon_correction_at_frame_boundaries(self):
        config = longn_config(targets=[{"unit_id": unit_id, "ip": "127.0.0.1", "universes": [unit_id - 1]}
                                       for unit_id in (1, 2)])
        motors = [[("stop", "cw")] * 5]
        moon = [True]
        time = FakeTime()

        def change():
            # 第 2 格起：第 1 台全速逆轉、第 2 台中速；第 3 格起關閉月亮校正。
            # From frame 2: unit 1 max/ccw, unit 2 mid; from frame 3 moon correction is off.
            if time.now >= 2 / 40:
                motors[0] = [("max", "ccw"), ("mid", "cw")] + [("stop", "cw")] * 3
            if time.now >= 3 / 40:
                moon[0] = False

        time.on_sleep = change
        _, clients = run_stream(config, "full-on", 4 / 40, time=time, motor_provider=lambda: motors[0],
                                moon_correction_provider=lambda: moon[0])
        unit1, unit2 = clients[0].packets[:4], clients[1].packets[:4]
        self.assertEqual([(0, 0), (0, 0), (230, 255), (230, 255)], [tuple(packet[456:458]) for packet in unit1])
        self.assertEqual([(0, 0), (0, 0), (60, 0), (60, 0)], [tuple(packet[456:458]) for packet in unit2])
        self.assertEqual(expected_payload(config, "full-on", 1, 2, speed="max", direction="ccw", moon=True), unit1[2])
        self.assertEqual(expected_payload(config, "full-on", 1, 3, speed="max", direction="ccw", moon=False), unit1[3])
        self.assertNotEqual(unit1[2][:456], unit1[3][:456])  # moon correction switched off
        self.assertEqual(unit2[2][:456], unit2[3][:456])  # mid speed is never corrected

    def test_virtual_phase_follows_each_units_speed_and_direction(self):
        config = longn_config(targets=[{"unit_id": unit_id, "ip": "127.0.0.1", "universes": [0]}
                                       for unit_id in (1, 2, 3)],
                              hardware={"color_order": "RGB", "brightness": 1.0, "moon_correction": False})
        motors = [("max", "cw"), ("max", "ccw"), ("stop", "cw"), ("stop", "cw"), ("stop", "cw")]
        _, clients = run_stream(config, "world-upper-half", 12 / 40, motor_provider=lambda: motors)
        step = math.tau * (500 / 60) / 40
        for unit_id, sign in ((1, 1), (2, -1), (3, 0)):
            for frame, packet in enumerate(clients[unit_id - 1].packets[:12]):
                speed, direction = motors[unit_id - 1]
                expected = expected_payload(config, "world-upper-half", unit_id, frame, speed=speed,
                                            direction=direction, phase=sign * step * frame)
                self.assertEqual(expected, packet, f"unit {unit_id} frame {frame}")
        self.assertEqual(1, len(set(clients[2].packets[:12])))  # a stopped unit never changes phase
        self.assertGreater(len(set(clients[0].packets[:12])), 1)

    def test_blackout_is_sent_even_when_the_loop_fails(self):
        def broken_motor():
            raise RuntimeError("provider failed")

        with self.assertRaisesRegex(RuntimeError, "provider failed"):
            run_stream(longn_config(), "full-on", 1.0, motor_provider=broken_motor)
        clients = []

        def factory(*args, **kwargs):
            clients.append(FakeClient(*args, **kwargs))
            return clients[-1]

        with self.assertRaises(RuntimeError):
            stream(longn_config(), validate_preset(default_preset("full-on"), 152), seconds=1.0,
                   client_factory=factory, motor_provider=broken_motor)
        self.assertEqual(10, len(clients))
        self.assertTrue(all(client.packets == [bytes(512)] * 2 and client.closed for client in clients))

    def test_motor_provider_must_cover_every_unit(self):
        with self.assertRaisesRegex(ValueError, "one \\(speed, direction\\) per unit"):
            run_stream(longn_config(), "full-on", 1 / 40, motor_provider=lambda: [("max", "cw")])


if __name__ == "__main__":
    unittest.main()
