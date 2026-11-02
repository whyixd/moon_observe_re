"""Shared sequence document, frame schedule, and atomic runtime storage."""

from __future__ import annotations

import copy
import json
import math
import os
from pathlib import Path
import tempfile
from threading import Lock
from typing import Any, Mapping

from .effects import completion_frames as _completion_frames, preset_to_json, validate_preset
from .renderer import render_frame

SEQUENCE_SCHEMA_VERSION = 1
MAX_STEPS = 64


def _rounded_frames(value: float) -> int:
    return math.floor(value + 0.5)



def validate_sequence(raw: Any, pixels: int = 156, fps: int = 40, unit_count: int = 9) -> dict[str, Any]:
    if not isinstance(raw, dict) or not {"schemaVersion", "steps"} <= set(raw) or set(raw) - {"schemaVersion", "steps", "ending"}:
        raise ValueError("sequence must contain schemaVersion and steps")
    if type(raw["schemaVersion"]) is not int or raw["schemaVersion"] != SEQUENCE_SCHEMA_VERSION:
        raise ValueError("unsupported sequence schemaVersion")
    ending = raw.get("ending", {"kind": "hold"})
    if not isinstance(ending, dict):
        raise ValueError("invalid sequence ending")
    if ending.get("kind") in ("hold", "loop") and set(ending) == {"kind"}:
        pass
    elif ending.get("kind") == "fade-black" and set(ending) == {"kind", "seconds"}:
        seconds = ending["seconds"]
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 1 / fps <= seconds <= 10:
            raise ValueError("ending fade seconds must be finite and within 1 frame..10")
    else:
        raise ValueError("invalid sequence ending")
    steps = raw["steps"]
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        raise ValueError(f"sequence must have 1..{MAX_STEPS} steps")
    ids: set[int] = set()
    result: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict) or set(step) != {"id", "preset", "playback", "transition"}:
            raise ValueError(f"step {index + 1} must contain id, preset, playback and transition")
        step_id = step["id"]
        if type(step_id) is not int or step_id <= 0 or step_id in ids:
            raise ValueError("sequence step ids must be distinct positive integers")
        ids.add(step_id)
        normalized_preset = validate_preset(step["preset"], pixels)
        playback = step["playback"]
        if not isinstance(playback, dict):
            raise ValueError("invalid sequence playback")
        if playback.get("kind") == "count" and set(playback) == {"kind", "count"}:
            count = playback["count"]
            if type(count) is not int or not 1 <= count <= 100:
                raise ValueError("playback count must be 1..100")
            if _completion_frames(normalized_preset, fps, unit_count) is None:
                raise ValueError("playback count requires an effect completion boundary")
        elif playback.get("kind") == "time" and set(playback) == {"kind", "seconds"}:
            seconds = playback["seconds"]
            if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 0 < seconds <= 3600:
                raise ValueError("playback seconds must be finite and within 1 frame..3600")
        else:
            raise ValueError("invalid sequence playback")
        transition = step["transition"]
        if not isinstance(transition, dict) or set(transition) != {"kind", "seconds"}:
            raise ValueError("invalid sequence transition")
        if transition["kind"] not in ("cut", "fade-black", "crossfade", "unit-fade-black"):
            raise ValueError("unknown sequence transition")
        seconds = transition["seconds"]
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 0 <= seconds <= 10:
            raise ValueError("transition seconds must be finite and within 0..10")
        result.append({**copy.deepcopy(step), "preset": preset_to_json(normalized_preset)})
    return {"schemaVersion": SEQUENCE_SCHEMA_VERSION, "ending": copy.deepcopy(ending), "steps": result}


def compile_sequence(document: Mapping[str, Any], fps: int, unit_count: int, pixels: int = 156) -> tuple[dict[str, Any], ...]:
    raw = validate_sequence(document, pixels, fps, unit_count)
    compiled: list[dict[str, Any]] = []
    start = 0
    for index, step in enumerate(raw["steps"]):
        preset = validate_preset(step["preset"], pixels)
        playback = step["playback"]
        cycle = _completion_frames(preset, fps, unit_count) if playback["kind"] == "count" else None
        duration = cycle * playback["count"] if cycle is not None else max(1, _rounded_frames(playback["seconds"] * fps))
        previous = raw["steps"][index - 1] if index else None
        transition_frames = 0 if previous is None or previous["transition"]["kind"] == "cut" else min(
            duration, max(0, _rounded_frames(previous["transition"]["seconds"] * fps))
        )
        compiled.append({
            "id": step["id"], "preset": preset, "start": start, "duration": duration, "cycle": cycle,
            "transition_frames": transition_frames,
            "transition_kind": step["transition"]["kind"],
        })
        start += duration
    ending = raw["ending"]
    last_transition = raw["steps"][-1]["transition"]
    compiled[0]["ending"] = ending
    compiled[0]["end_fade_frames"] = max(1, _rounded_frames(ending["seconds"] * fps)) if ending["kind"] == "fade-black" else 0
    compiled[0]["loop_transition_frames"] = (
        min(compiled[0]["duration"], max(0, _rounded_frames(last_transition["seconds"] * fps)))
        if ending["kind"] == "loop" and last_transition["kind"] != "cut" else 0
    )
    return tuple(compiled)


UnitFade = tuple[int, int] | None


def unit_fade_weight(fade: tuple[int, int], unit_index: int, unit_count: int) -> float:
    """Per-unit fade-out of unit-fade-black, identical to the frontend's unitFadeWeight.

    Each unit fades over a third of the first half (the whole half for one unit); start
    times spread evenly from unit 1 to the last, which reaches black at the midpoint.
    """
    elapsed, frames = fade
    fade_frames = frames / min(3, max(1, unit_count))
    start = 0 if unit_count <= 1 else (frames - fade_frames) * unit_index / (unit_count - 1)
    return 1 - min(1.0, max(0.0, (elapsed + 1 - start) / fade_frames))


def _layer_details(
    compiled: tuple[dict[str, Any], ...], frame: int,
) -> tuple[tuple[Mapping[str, Any], int, int | None, int, float, UnitFade], ...]:
    """Layers as (preset, elapsed frames in step, step cycle, source frame, weight, unit fade).

    unit fade is (elapsed, frames of the fade-out half) on the outgoing layer of a
    unit-fade-black transition, else None.
    """
    total = compiled[-1]["start"] + compiled[-1]["duration"]
    frame = max(0, frame)
    loop = compiled[0]["ending"]["kind"] == "loop"
    cycle_start = frame // total * total if loop else 0
    cycle_frame = frame - cycle_start if loop else frame
    complete = not loop and frame >= total
    if complete:
        last = compiled[-1]
        fade_frames = compiled[0]["end_fade_frames"]
        weight = max(0.0, 1 - (frame - total + 1) / fade_frames) if fade_frames else 1.0
        return ((last["preset"], last["duration"] - 1, last["cycle"], total - 1, weight, None),)

    index = next(i for i, step in enumerate(compiled) if cycle_frame < step["start"] + step["duration"])
    step = compiled[index]
    elapsed = cycle_frame - step["start"]
    source_frame = cycle_start + step["start"] + elapsed
    current = (step["preset"], elapsed, step["cycle"], source_frame, 1.0, None)
    frames = compiled[0]["loop_transition_frames"] if index == 0 and cycle_start > 0 else step["transition_frames"]
    if elapsed >= frames:
        return (current,)

    previous = compiled[index - 1] if index else compiled[-1]
    unit_fade: UnitFade = None
    if previous["transition_kind"] == "crossfade":
        current_weight = (elapsed + 1) / (frames + 1)
        outgoing_weight = 1 - current_weight
    else:
        midpoint = (frames - 1) // 2
        current_weight = (elapsed - midpoint) / (frames - 1 - midpoint) if elapsed > midpoint else 0.0
        if previous["transition_kind"] == "unit-fade-black":
            # 前半逐台淡出（各台權重見 unit_fade_weight），後半同 fade-black 一起淡入。
            # First half fades units out one by one (see unit_fade_weight); the second half fades in like fade-black.
            outgoing_weight = 1.0 if elapsed <= midpoint else 0.0
            unit_fade = (elapsed, midpoint + 1)
        else:
            outgoing_weight = 1 - (elapsed + 1) / (midpoint + 1) if elapsed < midpoint else 0.0
    prior_elapsed = previous["duration"] - 1
    prior_source = cycle_start + previous["start"] + prior_elapsed - (total if index == 0 else 0)
    outgoing = (previous["preset"], prior_elapsed, previous["cycle"], prior_source, outgoing_weight, unit_fade)
    return (outgoing, (step["preset"], elapsed, step["cycle"], source_frame, current_weight, None))


def sequence_position(compiled: tuple[dict[str, Any], ...], frame: int) -> dict[str, Any]:
    """Playback position at a frame: active step, repeat, transition and ending state."""
    total = compiled[-1]["start"] + compiled[-1]["duration"]
    frame = max(0, frame)
    ending = compiled[0]["ending"]["kind"]
    loop = ending == "loop"
    iteration = frame // total if loop else 0
    ended = not loop and frame >= total
    cycle_frame = frame - iteration * total if loop else min(frame, total - 1)
    index = next(i for i, step in enumerate(compiled) if cycle_frame < step["start"] + step["duration"])
    step = compiled[index]
    elapsed = cycle_frame - step["start"]
    cycle = step["cycle"]
    frames = compiled[0]["loop_transition_frames"] if index == 0 and iteration > 0 else step["transition_frames"]
    previous = index - 1 if index else len(compiled) - 1
    fade_frames = compiled[0]["end_fade_frames"]
    return {
        "frame": frame,
        "sequenceFrame": total if ended else cycle_frame,
        "totalFrames": total,
        "ending": ending,
        "loopIteration": iteration + 1,
        "ended": ended,
        "endFade": ({"elapsed": min(frame - total + 1, fade_frames), "frames": fade_frames}
                    if ended and fade_frames else None),
        "step": {
            "index": index, "id": step["id"], "effectId": step["preset"]["effectId"],
            "elapsed": elapsed, "duration": step["duration"],
            "repeat": {"current": elapsed // cycle + 1, "total": step["duration"] // cycle} if cycle else None,
        },
        "transition": (None if ended or elapsed >= frames else {
            "kind": compiled[previous]["transition_kind"], "fromIndex": previous,
            "elapsed": elapsed, "frames": frames,
        }),
    }


def sequence_layers(compiled: tuple[dict[str, Any], ...], frame: int) -> tuple[tuple[Mapping[str, Any], int, int, float], ...]:
    return tuple(
        (preset, elapsed if cycle is None else elapsed % cycle, source_frame, weight)
        for preset, elapsed, cycle, source_frame, weight, _ in _layer_details(compiled, frame)
    )


def render_sequence_frame(
    compiled: tuple[dict[str, Any], ...],
    unit: Mapping[str, Any],
    frame: int,
    *,
    unit_count: int,
    fps: int,
    rpm: int,
    rain: bool = False,
    color_override: Mapping[str, Any] | None = None,
) -> list[tuple[float, float, float]]:
    layers = _layer_details(compiled, frame)
    count = int(unit["logicalPixelCount"])
    result = [[0.0, 0.0, 0.0] for _ in range(count)]
    unit_index = int(unit["unitId"]) - 1
    for preset, elapsed, cycle, source_frame, weight, unit_fade in layers:
        if unit_fade is not None:
            weight *= unit_fade_weight(unit_fade, unit_index, unit_count)
        if weight <= 0:
            continue
        colors = render_frame(
            preset, unit, elapsed, unit_count=unit_count, fps=fps, rpm=rpm,
            phase_frame=source_frame, raining=rain, cycle_frames=cycle,
            color_override=color_override,
        )
        for target, color in zip(result, colors):
            for channel in range(3):
                target[channel] += color[channel] * weight
    return [tuple(color) for color in result]


class SequenceStore:
    def __init__(self, path: str | Path, pixels: int, fps: int, unit_count: int, fallback_preset: Mapping[str, Any]) -> None:
        self.path = Path(path)
        self.pixels = pixels
        self.fps = fps
        self.unit_count = unit_count
        self.lock = Lock()
        self.revision = 0
        self.generation = 0
        self.mode = "sequence"
        if self.path.exists():
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            self.raw = validate_sequence(raw, pixels, fps, unit_count)
        else:
            self.raw = validate_sequence({
                "schemaVersion": SEQUENCE_SCHEMA_VERSION,
                "ending": {"kind": "hold"},
                "steps": [{
                    "id": 1, "preset": fallback_preset,
                    "playback": {"kind": "time", "seconds": 8},
                    "transition": {"kind": "cut", "seconds": 0.5},
                }],
            }, pixels, fps, unit_count)
            self._write(self.raw)
        self.compiled = compile_sequence(self.raw, fps, unit_count, pixels)

    def _write(self, document: Mapping[str, Any]) -> None:
        encoded = (json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", prefix=".sequence-", suffix=".tmp", dir=self.path.parent, delete=False) as stream:
                temporary = stream.name
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            temporary = None
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)

    def state(self) -> dict[str, Any]:
        with self.lock:
            return {"revision": self.revision, "sequence": copy.deepcopy(self.raw), "playbackMode": self.mode}

    def snapshot(self) -> tuple[str, tuple[dict[str, Any], ...], int]:
        with self.lock:
            return self.mode, self.compiled, self.generation

    def apply(self, raw: Any) -> dict[str, Any]:
        document = validate_sequence(raw, self.pixels, self.fps, self.unit_count)
        compiled = compile_sequence(document, self.fps, self.unit_count, self.pixels)
        with self.lock:
            self._write(document)
            self.raw = document
            self.compiled = compiled
            self.revision += 1
            self.generation += 1
            self.mode = "sequence"
            return self.state_unlocked()

    def use_single_preset(self) -> None:
        with self.lock:
            self.mode = "single"
            self.generation += 1

    def restart(self, raw: Any) -> dict[str, Any]:
        """Replay the chosen source from frame 0 without rewriting any file."""
        if not isinstance(raw, dict) or set(raw) != {"source"} or raw["source"] not in ("sequence", "single"):
            raise ValueError("restart must be {\"source\": \"sequence\"|\"single\"}")
        with self.lock:
            self.mode = raw["source"]
            self.generation += 1
            return self.state_unlocked()

    def state_unlocked(self) -> dict[str, Any]:
        return {"revision": self.revision, "sequence": copy.deepcopy(self.raw), "playbackMode": self.mode}
