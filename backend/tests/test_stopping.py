import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

BACKEND = Path(__file__).resolve().parents[1]
ARTNET_PORT = 6454  # stupidArtnet always sends to the standard Art-Net port.


@unittest.skipIf(os.name == "nt", "POSIX signals; the Windows service stop is tested on site (deploy/README.md)")
class StopSignalTests(unittest.TestCase):
    """Run the real backend and check that a stop request still sends the all-zero exit frames."""

    def setUp(self):
        self.receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.receiver.bind(("127.0.0.1", ARTNET_PORT))
        except OSError:
            self.receiver.close()
            self.skipTest(f"UDP {ARTNET_PORT} is in use")
        self.addCleanup(self.receiver.close)
        self.receiver.settimeout(5)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        (root / "preset.json").write_text((BACKEND / "preset.example.json").read_text(encoding="utf-8"), encoding="utf-8")
        (root / "config.toml").write_text(
            '[artnet]\nip = "127.0.0.1"\nuniverses = [0, 1]\n[render]\npreset = "preset.json"\nunit_count = 1\n',
            encoding="utf-8",
        )
        self.config = root / "config.toml"

    def run_and_stop(self, stop_signal, *, ignore_sigint=False):
        def preexec():
            if ignore_sigint:  # what a background job in a non-interactive shell inherits
                signal.signal(signal.SIGINT, signal.SIG_IGN)

        process = subprocess.Popen(
            [sys.executable, "-B", "run.py", "--config", str(self.config), "--api-port", "0", "--api-host", "127.0.0.1"],
            cwd=BACKEND, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, preexec_fn=preexec,
        )
        self.addCleanup(process.kill)
        packets = [self.receiver.recvfrom(1024)[0] for _ in range(4)]  # streaming has started
        process.send_signal(stop_signal)
        output, _ = process.communicate(timeout=10)
        self.receiver.settimeout(0.5)
        tail = []
        try:
            while True:
                tail.append(self.receiver.recvfrom(1024)[0][18:])
        except TimeoutError:
            pass
        return process.returncode, output, tail

    def assertCleanStop(self, returncode, output, tail):
        self.assertEqual(0, returncode, output)
        self.assertIn("Stopped", output)
        self.assertEqual([bytes(512)] * 4, tail[-4:])  # two all-zero frames x two universes

    def test_sigterm_stops_cleanly(self):
        self.assertCleanStop(*self.run_and_stop(signal.SIGTERM))

    def test_sigint_stops_cleanly_even_when_inherited_as_ignored(self):
        self.assertCleanStop(*self.run_and_stop(signal.SIGINT, ignore_sigint=True))


if __name__ == "__main__":
    unittest.main()
