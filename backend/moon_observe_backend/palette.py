"""Temperature palette for weather gradients, editable through the API."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import tempfile
from threading import Lock
from typing import Any

from .effects import _number, _rgb

PALETTE_SCHEMA_VERSION = 1
MAX_BANDS = 12


def _hex(value: int) -> dict[str, float]:
    return {"r": (value >> 16 & 0xFF) / 255, "g": (value >> 8 & 0xFF) / 255, "b": (value & 0xFF) / 255}


DEFAULT_PALETTE: dict[str, Any] = {
    "schemaVersion": PALETTE_SCHEMA_VERSION,
    "axis": "radius",
    "bands": [
        {"belowC": 18, "colors": [_hex(0x2444AA), _hex(0x72D8FF)]},
        {"belowC": 28, "colors": [_hex(0x328BD2), _hex(0x8FFFC8)]},
        {"belowC": None, "colors": [_hex(0xFFB347), _hex(0xFF477E)]},
    ],
}


def validate_palette(raw: Any) -> dict[str, Any]:
    """Return a canonical palette or raise ValueError.

    Bands are ordered by ``belowC`` (strictly increasing, -100..70); the last
    band has ``belowC: null`` and covers every warmer temperature.
    """
    if not isinstance(raw, dict) or set(raw) != {"schemaVersion", "axis", "bands"}:
        raise ValueError("palette must contain schemaVersion, axis, bands")
    if type(raw["schemaVersion"]) is not int or raw["schemaVersion"] != PALETTE_SCHEMA_VERSION:
        raise ValueError("unsupported palette schemaVersion")
    if raw["axis"] not in ("strip", "radius"):
        raise ValueError("palette axis must be strip or radius")
    bands = raw["bands"]
    if not isinstance(bands, list) or not 1 <= len(bands) <= MAX_BANDS:
        raise ValueError(f"palette needs 1..{MAX_BANDS} bands")
    result = []
    previous: float | None = None
    for index, band in enumerate(bands):
        name = f"bands[{index}]"
        if not isinstance(band, dict) or set(band) != {"belowC", "colors"}:
            raise ValueError(f"{name} must contain belowC and colors")
        last = index == len(bands) - 1
        if last:
            if band["belowC"] is not None:
                raise ValueError("the last band must have belowC null")
            below = None
        else:
            below = _number(band["belowC"], f"{name}.belowC", -100, 70)
            if previous is not None and below <= previous:
                raise ValueError("band belowC values must increase")
            previous = below
        colors = band["colors"]
        if not isinstance(colors, list) or not 2 <= len(colors) <= 8:
            raise ValueError(f"{name}.colors needs 2..8 colors")
        result.append({
            "belowC": below,
            "colors": [dict(zip("rgb", _rgb(color, f"{name}.colors[{i}]"))) for i, color in enumerate(colors)],
        })
    return {"schemaVersion": PALETTE_SCHEMA_VERSION, "axis": raw["axis"], "bands": result}


def load_palette(path: str | Path) -> dict[str, Any]:
    """Read and validate a palette file; a missing file means the default palette."""
    try:
        with Path(path).open("r", encoding="utf-8") as stream:
            return validate_palette(json.load(stream))
    except FileNotFoundError:
        return copy.deepcopy(DEFAULT_PALETTE)


def gradient_for(temperature: float, palette: dict[str, Any] = DEFAULT_PALETTE) -> dict[str, Any]:
    band = next(band for band in palette["bands"] if band["belowC"] is None or temperature < band["belowC"])
    return {"mode": "gradient", "axis": palette["axis"], "colors": [dict(color) for color in band["colors"]]}


class PaletteStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.lock = Lock()
        # Replaced on save, never mutated, so the render loop may read it without the lock.
        self.palette = load_palette(self.path)

    def state(self) -> dict[str, Any]:
        with self.lock:
            return copy.deepcopy(self.palette)

    def apply(self, raw: Any) -> dict[str, Any]:
        palette = validate_palette(raw)
        encoded = (json.dumps(palette, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        with self.lock:
            temporary: str | None = None
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(mode="wb", prefix=".palette-", suffix=".tmp", dir=self.path.parent, delete=False) as stream:
                    temporary = stream.name
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
                temporary = None
                self.palette = palette
            finally:
                if temporary is not None:
                    Path(temporary).unlink(missing_ok=True)
            return copy.deepcopy(palette)
