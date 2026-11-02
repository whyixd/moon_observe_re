"""Minimal TOML configuration for Art-Net outputs, LongN hardware/motor and optional weather."""

from __future__ import annotations

import ipaddress
import json
import math
from pathlib import Path
import tomllib
from typing import Any

from .effects import validate_preset
from .hardware import CHANNELS_PER_PIXEL, COLOR_ORDERS, DIRECTIONS, MAX_PIXELS, PACKET_SIZE, SPEED_LEVELS

# LongN 的硬體預設（LongN/Artnet.pde、LongN.pde）；[hardware]、[motor] 整段或個別欄位都可省略。
# LongN hardware defaults; the [hardware] and [motor] sections and each of their fields are optional.
DEFAULT_HARDWARE = {"color_order": "GRB", "brightness": 0.4, "moon_correction": True}
DEFAULT_MOTOR = {
    "speed_channel": 457,
    "direction_channel": 458,
    "speeds": {"stop": 0, "mid": 60, "max": 230},
    "directions": {"cw": 0, "ccw": 255},
    "rpm": {"mid": 130, "max": 500},
}
MAX_UNIVERSES_PER_TARGET = 4


def _ipv4(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be an IPv4 address")
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise ValueError(f"{name} must be an IPv4 address") from None
    if address.is_multicast or address.is_unspecified:
        raise ValueError(f"{name} must be a unicast IPv4 address")
    return str(address)


def _integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}]")
    return value


def _coordinate(value: Any, name: str, minimum: float, maximum: float) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return float(value)


def _boolean(value: Any, name: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f"{name} must be true or false")
    return value


def _level_table(value: Any, name: str, keys: tuple[str, ...], maximum: int) -> dict[str, int]:
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(f"{name} requires exactly {', '.join(keys)}")
    return {key: _integer(value[key], f"{name}.{key}", 0, maximum) for key in keys}


def _universes(entry: dict[str, Any], name: str) -> list[int]:
    """Exactly one of ``universe = n`` or ``universes = [n, ...]`` (default universe 0)."""
    if "universe" in entry and "universes" in entry:
        raise ValueError(f"{name} accepts universe or universes, not both")
    if "universes" not in entry:
        return [_integer(entry.get("universe", 0), f"{name}.universe", 0, 32767)]
    values = entry["universes"]
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_UNIVERSES_PER_TARGET:
        raise ValueError(f"{name}.universes must list 1..{MAX_UNIVERSES_PER_TARGET} universes")
    universes = [_integer(value, f"{name}.universes[{index}]", 0, 32767) for index, value in enumerate(values)]
    if len(set(universes)) != len(universes):
        raise ValueError(f"{name}.universes must not repeat")
    return universes


def _hardware(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) - set(DEFAULT_HARDWARE):
        raise ValueError("unknown hardware config field")
    color_order = raw.get("color_order", DEFAULT_HARDWARE["color_order"])
    if color_order not in COLOR_ORDERS:
        raise ValueError(f"hardware.color_order must be one of {', '.join(COLOR_ORDERS)}")
    return {
        "color_order": color_order,
        "brightness": _coordinate(raw.get("brightness", DEFAULT_HARDWARE["brightness"]), "hardware.brightness", 0, 1),
        "moon_correction": _boolean(raw.get("moon_correction", DEFAULT_HARDWARE["moon_correction"]), "hardware.moon_correction"),
    }


def _motor(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) - set(DEFAULT_MOTOR):
        raise ValueError("unknown motor config field")
    speed_channel = _integer(raw.get("speed_channel", DEFAULT_MOTOR["speed_channel"]), "motor.speed_channel", 1, PACKET_SIZE)
    direction_channel = _integer(raw.get("direction_channel", DEFAULT_MOTOR["direction_channel"]), "motor.direction_channel", 1, PACKET_SIZE)
    if speed_channel == direction_channel:
        raise ValueError("motor.speed_channel and motor.direction_channel must differ")
    return {
        "speed_channel": speed_channel,
        "direction_channel": direction_channel,
        "speeds": _level_table(raw.get("speeds", DEFAULT_MOTOR["speeds"]), "motor.speeds", SPEED_LEVELS, 255),
        "directions": _level_table(raw.get("directions", DEFAULT_MOTOR["directions"]), "motor.directions", DIRECTIONS, 255),
        "rpm": _level_table(raw.get("rpm", DEFAULT_MOTOR["rpm"]), "motor.rpm", ("mid", "max"), 10000),
    }


def _file_name(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must name a JSON file")
    return value


def load_config(path: str | Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Load host/network settings from TOML and EffectPreset v2 from JSON."""
    config_path = Path(path).resolve()
    with config_path.open("rb") as stream:
        raw = tomllib.load(stream)
    sections = set(raw)
    if not {"artnet", "render"} <= sections or sections - {"artnet", "render", "hardware", "motor", "weather"} \
            or not isinstance(raw["artnet"], dict) or not isinstance(raw["render"], dict):
        raise ValueError("config requires [artnet] and [render] sections (optional: [hardware], [motor], [weather])")
    artnet = raw["artnet"]
    render = raw["render"]
    if set(artnet) - {"ip", "universe", "universes", "source_ip", "targets"} or set(render) - {"preset", "sequence", "fps", "pixels", "unit_id", "unit_count"}:
        raise ValueError("unknown config field")
    hardware = _hardware(raw.get("hardware", {}))
    motor = _motor(raw.get("motor", {}))
    source_ip = _ipv4(artnet["source_ip"], "artnet.source_ip") if "source_ip" in artnet else None
    fps = _integer(render.get("fps", 40), "render.fps", 1, 120)
    pixels = _integer(render.get("pixels", 152), "render.pixels", 1, MAX_PIXELS)
    if pixels * CHANNELS_PER_PIXEL >= min(motor["speed_channel"], motor["direction_channel"]):
        raise ValueError("render.pixels channels overlap motor.speed_channel/direction_channel")
    unit_count = _integer(render.get("unit_count", 5), "render.unit_count", 1, 9)
    unit_id = _integer(render.get("unit_id", 1), "render.unit_id", 1, unit_count)

    if "targets" in artnet:
        if {"ip", "universe", "universes"} & set(artnet) or not isinstance(artnet["targets"], list) or not artnet["targets"]:
            raise ValueError("artnet.targets must replace ip/universe and contain at least one target")
        targets = []
        for index, target in enumerate(artnet["targets"]):
            name = f"artnet.targets[{index}]"
            if not isinstance(target, dict) or not {"unit_id", "ip"} <= set(target) \
                    or not {"universe", "universes"} & set(target) \
                    or set(target) - {"unit_id", "ip", "universe", "universes"}:
                raise ValueError("each artnet target requires unit_id, ip and universe or universes")
            targets.append({
                "unit_id": _integer(target["unit_id"], f"{name}.unit_id", 1, unit_count),
                "ip": _ipv4(target["ip"], f"{name}.ip"),
                "universes": _universes(target, name),
            })
        if len({target["unit_id"] for target in targets}) != len(targets):
            raise ValueError("artnet target unit_id values must be unique")
    else:
        targets = [{
            "unit_id": unit_id, "ip": _ipv4(artnet.get("ip"), "artnet.ip"),
            "universes": _universes(artnet, "artnet"),
        }]
    pairs = [(target["ip"], universe) for target in targets for universe in target["universes"]]
    if len(set(pairs)) != len(pairs):
        raise ValueError("artnet target IP/universe pairs must be unique")

    weather = None
    if "weather" in raw:
        entry = raw["weather"]
        if not isinstance(entry, dict) or set(entry) - {"latitude", "longitude", "interval_minutes", "cloud_step", "palette", "visits"}:
            raise ValueError("unknown weather config field")
        raw_visits = entry.get("visits", [])
        if not isinstance(raw_visits, list) or len(raw_visits) > 24:
            raise ValueError("weather.visits must list at most 24 locations")
        visits = []
        for index, visit in enumerate(raw_visits):
            if not isinstance(visit, dict) or set(visit) != {"name", "latitude", "longitude"}:
                raise ValueError(f"weather.visits[{index}] requires name, latitude and longitude")
            name = visit["name"]
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
                raise ValueError(f"weather.visits[{index}].name must be 1..40 characters")
            visits.append({
                "name": name.strip(),
                "latitude": _coordinate(visit["latitude"], f"weather.visits[{index}].latitude", -90, 90),
                "longitude": _coordinate(visit["longitude"], f"weather.visits[{index}].longitude", -180, 180),
            })
        weather = {
            "latitude": _coordinate(entry.get("latitude"), "weather.latitude", -90, 90),
            "longitude": _coordinate(entry.get("longitude"), "weather.longitude", -180, 180),
            "interval_minutes": _integer(entry.get("interval_minutes", 15), "weather.interval_minutes", 1, 1440),
            "cloud_step": _integer(entry.get("cloud_step", 6), "weather.cloud_step", 4, 8),
            "palette_path": str((config_path.parent / _file_name(entry.get("palette", "palette.json"), "weather.palette")).resolve()),
            "visits": visits,
        }

    preset_name = render.get("preset")
    if not isinstance(preset_name, str) or not preset_name:
        raise ValueError("render.preset must name a JSON file")
    preset_path = (config_path.parent / preset_name).resolve()
    sequence_name = render.get("sequence", "sequence.json")
    if not isinstance(sequence_name, str) or not sequence_name:
        raise ValueError("render.sequence must name a JSON file")
    sequence_path = (config_path.parent / sequence_name).resolve()
    with preset_path.open("r", encoding="utf-8") as stream:
        preset = validate_preset(json.load(stream), pixels)
    config = {
        "source_ip": source_ip,
        "targets": targets,
        "weather": weather,
        "fps": fps,
        "pixels": pixels,
        "hardware": hardware,
        "motor": motor,
        "unit_count": unit_count,
        "preset_path": str(preset_path),
        "sequence_path": str(sequence_path),
    }
    return config, preset
