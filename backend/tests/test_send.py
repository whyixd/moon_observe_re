import json
from pathlib import Path
import socket
import tempfile
import unittest

from stupidArtnet import StupidArtnet

from moon_observe_backend.config import load_config
from moon_observe_backend.effects import default_preset, validate_preset
from moon_observe_backend.output import stream
from moon_observe_backend.renderer import render_frame, rgb_bytes


def example_config():
    return {
        "ip": "192.0.2.20", "source_ip": "192.0.2.10", "universe": 0x1234,
        "fps": 40, "rpm": 360, "pixels": 156, "unit_id": 1, "unit_count": 9,
    }


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


class SendTests(unittest.TestCase):
    def test_toml_config_loads_json_preset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "preset.json").write_text(json.dumps(default_preset("random-leds")), encoding="utf-8")
            config_path = root / "config.toml"
            config_path.write_text(
                '[artnet]\nip = "192.0.2.20"\nuniverse = 0\n'
                '[render]\npreset = "preset.json"\nfps = 40\nrpm = 360\npixels = 156\nunit_id = 1\nunit_count = 9\n',
                encoding="utf-8",
            )
            config, preset = load_config(config_path)
            self.assertEqual(0, config["universe"])
            self.assertIsNone(config["source_ip"])
            self.assertEqual("random-leds", preset["effectId"])
            config_path.write_text(config_path.read_text(encoding="utf-8") + 'unexpected = "value"\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unknown config field"):
                load_config(config_path)

    def test_stupidartnet_sends_real_artdmx_on_loopback(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(("127.0.0.1", 0))
            receiver.settimeout(1)
            target_port = receiver.getsockname()[1]

            def client_factory(*args, **kwargs):
                return StupidArtnet(*args, port=target_port, **kwargs)

            config = {**example_config(), "ip": "127.0.0.1", "source_ip": None, "universe": 0}
            preset = validate_preset(default_preset("center-out-sine"))
            stream(config, preset, seconds=0.01, client_factory=client_factory)
            packet, _ = receiver.recvfrom(1024)
        self.assertEqual(b"Art-Net\x00\x00\x50", packet[:10])
        self.assertEqual(18 + 470, len(packet))
        self.assertEqual(b"\x00\x00", packet[14:16])
        self.assertEqual(b"\x01\xd6", packet[16:18])
        self.assertEqual(b"\x00\x00", packet[18 + 468:18 + 470])

    def test_only_library_client_sends_frontend_sized_frames(self):
        clients = []
        now = [0.0]

        def factory(*args, **kwargs):
            client = FakeClient(*args, **kwargs)
            clients.append(client)
            return client

        def sleep(seconds):
            now[0] += seconds

        preset = validate_preset(default_preset("random-leds"))
        count = stream(
            example_config(), preset, seconds=0.075,
            client_factory=factory, clock=lambda: now[0], sleep=sleep,
        )
        self.assertEqual(3, count)
        client = clients[0]
        self.assertEqual(("192.0.2.20", 4, 470, {"fps": 40, "source_address": ("192.0.2.10", 0)}), client.init)
        self.assertFalse(client.simplified)
        self.assertEqual((0x12, 3), (client.net, client.subnet))
        self.assertEqual([470, 470, 470], [len(packet) for packet in client.packets])
        self.assertTrue(all(packet[468:] == b"\x00\x00" for packet in client.packets))
        self.assertTrue(client.closed)

    def test_motor_uses_one_based_channel_469_and_stops_on_exit(self):
        clients = []
        now = [0.0]
        motor = [0]

        def factory(*args, **kwargs):
            client = FakeClient(*args, **kwargs)
            clients.append(client)
            return client

        def sleep(seconds):
            now[0] += seconds
            motor[0] = 255

        preset = validate_preset(default_preset("spectrum-cycle"))
        count = stream(
            example_config(), preset, seconds=0.075, client_factory=factory,
            motor_provider=lambda: motor[0], clock=lambda: now[0], sleep=sleep,
        )
        self.assertEqual(3, count)
        packets = clients[0].packets
        self.assertEqual([0, 255, 255, 0], [packet[468] for packet in packets])
        self.assertEqual([470] * 4, [len(packet) for packet in packets])
        self.assertTrue(all(packet[469] == 0 for packet in packets))
        self.assertEqual(
            rgb_bytes(render_frame(preset, {"unitId": 1, "logicalPixelCount": 156, "frameOffset": 0}, 1)),
            packets[1][:468],
        )
        self.assertEqual(packets[2][:468], packets[3][:468])


if __name__ == "__main__":
    unittest.main()
