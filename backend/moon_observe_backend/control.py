"""Preset and motor-command API; Art-Net output remains in the main loop."""

from __future__ import annotations

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import tempfile
from threading import Lock
from typing import Any, Mapping

from .effects import preset_to_json, validate_preset

MOTOR_CHANNEL = 469  # Art-Net/DMX channels are numbered from 1.


class PresetStore:
    def __init__(self, preset_path: str | Path, pixels: int) -> None:
        self.path = Path(preset_path)
        self.pixels = pixels
        self.lock = Lock()
        self.active = validate_preset(json.loads(self.path.read_text(encoding="utf-8")), pixels)
        self.raw = preset_to_json(self.active)
        self.revision = 0
        self.motor_enabled = False  # Never resume a running motor after backend restart.

    def snapshot(self) -> Mapping[str, Any]:
        with self.lock:
            return self.active

    def motor_value(self) -> int:
        with self.lock:
            return 255 if self.motor_enabled else 0

    def apply_motor(self, raw: Any, config: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(raw, dict) or set(raw) != {"enabled"} or type(raw["enabled"]) is not bool:
            raise ValueError("motor command must be {\"enabled\": true|false}")
        with self.lock:
            if self.motor_enabled != raw["enabled"]:
                self.motor_enabled = raw["enabled"]
                self.revision += 1
            return self._state_unlocked(config)

    def state(self, config: Mapping[str, Any]) -> dict[str, Any]:
        with self.lock:
            return self._state_unlocked(config)

    def apply(self, raw: Any, config: Mapping[str, Any]) -> dict[str, Any]:
        normalized = validate_preset(raw, self.pixels)
        canonical = preset_to_json(normalized)
        encoded = (json.dumps(canonical, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        with self.lock:
            temporary: str | None = None
            try:
                with tempfile.NamedTemporaryFile(mode="wb", prefix=".preset-", suffix=".tmp", dir=self.path.parent, delete=False) as stream:
                    temporary = stream.name
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
                temporary = None
                self.raw = canonical
                self.active = normalized
                self.revision += 1
            finally:
                if temporary is not None:
                    Path(temporary).unlink(missing_ok=True)
            return self._state_unlocked(config)

    def _state_unlocked(self, config: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "revision": self.revision,
            "preset": self.raw,
            "motor": {"channel": MOTOR_CHANNEL, "enabled": self.motor_enabled,
                      "value": 255 if self.motor_enabled else 0},
            "output": {
                "ip": config["ip"], "universe": config["universe"],
                "fps": config["fps"], "rpm": config["rpm"],
                "unitId": config["unit_id"], "unitCount": config["unit_count"],
                "targets": config.get("targets", [{"unit_id": config["unit_id"], "ip": config["ip"], "universe": config["universe"]}]),
            },
        }


def make_server(
    store: PresetStore,
    config: Mapping[str, Any],
    port: int,
    *,
    host: str = "127.0.0.1",
    sequence_store: Any = None,
    frontend_dir: str | Path | None = None,
    weather_store: Any = None,
    playback_monitor: Any = None,
    unit_color_store: Any = None,
) -> ThreadingHTTPServer:
    if not 0 <= port <= 65535:
        raise ValueError("api port must be 0..65535")
    try:
        address = str(ipaddress.IPv4Address(host))
    except (ipaddress.AddressValueError, TypeError):
        raise ValueError("API host must be an IPv4 address") from None
    static_dir = Path(frontend_dir).resolve() if frontend_dir is not None else None
    palette_store = getattr(weather_store, "palette", None)
    if static_dir is not None and not (static_dir.is_dir() and (static_dir / "index.html").is_file()):
        raise ValueError("frontend directory must contain index.html")

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, directory=str(static_dir) if static_dir else None, **kwargs)

        def _respond(self, status: int, value: Mapping[str, Any]) -> None:
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _sequence_state(self) -> dict[str, Any]:
            result = sequence_store.state()
            result["output"] = {
                "fps": config["fps"], "rpm": config["rpm"],
                "unitCount": config["unit_count"],
            }
            return result

        def do_GET(self) -> None:
            if self.path == "/api/weather":
                self._respond(200, weather_store.snapshot() if weather_store is not None else {"enabled": False})
            elif self.path == "/api/weather/palette" and palette_store is not None:
                self._respond(200, palette_store.state())
            elif self.path == "/api/state":
                self._respond(200, store.state(config))
            elif self.path == "/api/sequence" and sequence_store is not None:
                self._respond(200, self._sequence_state())
            elif self.path == "/api/playback":
                result = playback_monitor.state() if playback_monitor is not None else {"active": False}
                test = unit_color_store.snapshot() if unit_color_store is not None else None
                if result["active"] and test is not None and test["active"]:
                    # 讓 3D 鏡像也顯示單色測試。 / Lets the 3D mirror show the unit colour test.
                    result["unitColors"] = test["colors"]
                self._respond(200, result)
            elif self.path == "/api/test/units" and unit_color_store is not None:
                self._respond(200, unit_color_store.snapshot())
            elif self.path.startswith("/api/") or static_dir is None:
                self._respond(404, {"error": "not found"})
            else:
                super().do_GET()

        def do_HEAD(self) -> None:
            if self.path.startswith("/api/") or static_dir is None:
                self.send_error(404)
            else:
                super().do_HEAD()

        def do_DELETE(self) -> None:
            if self.path == "/api/weather/override" and weather_store is not None:
                self._respond(200, weather_store.clear_override())
            elif self.path == "/api/weather/visit" and weather_store is not None:
                self._respond(200, weather_store.end_visit())
            elif self.path == "/api/test/units" and unit_color_store is not None:
                self._respond(200, unit_color_store.clear())
            else:
                self._respond(404, {"error": "not found"})

        def do_PUT(self) -> None:
            limits = {
                "/api/preset": 16384, "/api/motor": 64, "/api/sequence": 262144,
                "/api/weather/override": 256, "/api/weather/palette": 16384,
                "/api/playback/restart": 64, "/api/weather/visit": 64, "/api/test/units": 4096,
            }
            if (self.path not in limits
                    or (self.path in ("/api/sequence", "/api/playback/restart") and sequence_store is None)
                    or (self.path in ("/api/weather/override", "/api/weather/visit") and weather_store is None)
                    or (self.path == "/api/weather/palette" and palette_store is None)
                    or (self.path == "/api/test/units" and unit_color_store is None)):
                self._respond(404, {"error": "not found"})
                return
            if self.headers.get_content_type() != "application/json":
                self._respond(415, {"error": "Content-Type must be application/json"})
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                length = 0
            limit = limits[self.path]
            if not 0 < length <= limit:
                self._respond(413, {"error": f"JSON must be 1..{limit} bytes"})
                return
            try:
                raw = json.loads(self.rfile.read(length))
                if self.path == "/api/sequence":
                    sequence_store.apply(raw)
                    result = self._sequence_state()
                elif self.path == "/api/playback/restart":
                    sequence_store.restart(raw)
                    result = self._sequence_state()
                elif self.path == "/api/preset":
                    result = store.apply(raw, config)
                    if sequence_store is not None:
                        sequence_store.use_single_preset()
                elif self.path == "/api/weather/override":
                    result = weather_store.set_override(raw)
                elif self.path == "/api/weather/visit":
                    result = weather_store.start_visit(raw)
                elif self.path == "/api/weather/palette":
                    result = palette_store.apply(raw)
                elif self.path == "/api/test/units":
                    result = unit_color_store.apply(raw)
                else:
                    result = store.apply_motor(raw, config)
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
                self._respond(422, {"error": str(error)})
                return
            except OSError:
                self._respond(500, {"error": "data could not be saved"})
                return
            self._respond(200, result)

        def log_message(self, _format: str, *_args: object) -> None:
            pass

    return ThreadingHTTPServer((address, port), Handler)
