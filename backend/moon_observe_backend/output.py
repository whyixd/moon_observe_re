"""Continuous effect output through stupidArtnet in the LongN frame layout (LEDs + motor per unit)."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
import time
import tomllib
from threading import Thread
from typing import Any, Callable, Mapping, Sequence

from stupidArtnet import StupidArtnet

from .config import load_config
from .control import PresetStore, make_server
from .motor import HardwareStore, MotorStore
from .effects import Rgb, completion_frames
from .hardware import PACKET_SIZE, blackout_payload, build_payload
from .renderer import render_frame
from .sequence import SequenceStore, render_sequence_frame
from .schedule import Scheduler, ScheduleStore
from .stopping import install_stop_handlers
from .palette import PaletteStore
from .playback import PlaybackMonitor
from .unit_colors import UnitColorStore
from .weather import WeatherStore

EXIT_BLACKOUT_REPEATS = 2  # LongN sent the all-zero frame twice on exit (LEDs off, motor stop).
SINGLE_ROUND_SECONDS = 60  # A single effect "round" for weather visits: at least this long.


def round_length(sequence: Any, preset: Mapping[str, Any], fps: int, unit_count: int) -> tuple[int, bool]:
    """(frames per round, whether rounds repeat) for the playback being output."""
    if sequence is not None:
        total = sequence[-1]["start"] + sequence[-1]["duration"]
        return total, sequence[0]["ending"]["kind"] == "loop"
    minimum = SINGLE_ROUND_SECONDS * fps
    cycle = completion_frames(preset, fps, unit_count)
    return (cycle * math.ceil(minimum / cycle) if cycle else minimum), True


def boundary_key(sequence: Any, preset: Mapping[str, Any], playback_frame: int, fps: int,
                 unit_count: int) -> tuple[int, int] | None:
    """Changes when a new sequence step (or, for a single effect, a new cycle) starts; None once a
    non-looping sequence has ended. Deferred weather timing applies when it changes."""
    if sequence is None:
        cycle = completion_frames(preset, fps, unit_count) or round_length(None, preset, fps, unit_count)[0]
        return 0, playback_frame // cycle
    total, looping = round_length(sequence, preset, fps, unit_count)
    if not looping and playback_frame >= total:
        return None
    position = playback_frame % total if looping else playback_frame
    index = next(i for i, step in enumerate(sequence) if position < step["start"] + step["duration"])
    return playback_frame // total, index


def stream(
    config: Mapping[str, Any],
    preset: Mapping[str, Any],
    *,
    seconds: float | None = None,
    client_factory: Callable[..., Any] = StupidArtnet,
    preset_provider: Callable[[], Mapping[str, Any]] | None = None,
    motor_provider: Callable[[], Sequence[tuple[str, str]]] | None = None,
    moon_correction_provider: Callable[[], bool] | None = None,
    sequence_provider: Callable[[], tuple[str, tuple[dict[str, Any], ...], int]] | None = None,
    weather_provider: Callable[[], Mapping[str, Any]] | None = None,
    playback_reporter: Callable[[str, Any, int, int], None] | None = None,
    playback_advance: Callable[[int, int, bool, bool], None] | None = None,
    unit_colors_provider: Callable[[], Sequence[Rgb | None] | None] | None = None,
    scheduler: Scheduler | None = None,
    clock: Callable[[], float] = time.perf_counter,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Send frames continuously; returned count is send calls, not delivery ACKs.

    Every unit gets one 512-byte frame per output frame (``hardware.build_payload``), sent unchanged to
    each of its universes. ``motor_provider`` returns (speed, direction) per unit (index = unit_id - 1);
    without it every motor stays stopped. On exit every universe gets the all-zero frame twice.
    ``scheduler`` (timed shows) overrides the motors, dims or blacks out the lights and restarts playback
    from step 1 when a round begins; while it is disabled the output is exactly as without it.
    """
    if seconds is not None and (not math.isfinite(seconds) or seconds <= 0):
        raise ValueError("seconds must be positive and finite")
    fps = config["fps"]
    unit_count = config["unit_count"]
    hardware, motor = config["hardware"], config["motor"]
    clients: list[tuple[Mapping[str, Any], Any]] = []
    # 每台的虛擬轉角依各自目前的 rpm 累加；停止時不動。沒有回授，只是估計。
    # Each unit's virtual rotor angle advances at its own current rpm and holds while stopped (an estimate, no feedback).
    phases = [0.0] * unit_count
    last_sequence_generation: int | None = None
    last_weather_generation: int | None = None
    playback_start_frame = 0
    restarts = 0
    last_frame: int | None = None
    last_boundary: tuple[int, int] | None = None
    try:
        for target in config["targets"]:
            for universe in target["universes"]:
                client = client_factory(
                    target["ip"], universe & 0x0F, PACKET_SIZE, fps=fps,
                    source_address=(config["source_ip"], 0) if config["source_ip"] else None,
                )
                clients.append((target, client))
                client.set_simplified(False)
                client.set_net(universe >> 8)
                client.set_subnet((universe >> 4) & 0x0F)
        start = clock()
        frame = 0
        sent = 0
        while True:
            elapsed = clock() - start
            if seconds is not None and elapsed >= seconds:
                break
            due = max(0, math.floor(elapsed * fps))
            if due < frame:
                sleep(min((frame / fps) - elapsed, seconds - elapsed if seconds is not None else math.inf))
                continue
            frame = due
            sequence_state = sequence_provider() if sequence_provider is not None else None
            sequence_generation = sequence_state[2] if sequence_state is not None else None
            restarted = sequence_generation != last_sequence_generation
            if restarted:
                playback_start_frame = frame
                last_sequence_generation = sequence_generation
            active_preset = preset_provider() if preset_provider is not None else preset
            sequence_mode = sequence_state is not None and sequence_state[0] == "sequence"
            schedule = sequence_state[1] if sequence_mode else None
            show = None
            if scheduler is not None:
                show = scheduler.advance(
                    0 if last_frame is None else frame - last_frame,
                    round_length(schedule, active_preset, fps, unit_count)[0],
                    frame - playback_start_frame,
                )
                if show.restart:
                    playback_start_frame = frame
                    restarted = True
                if show.phase == "disabled":
                    show = None
            if playback_advance is not None:
                # 讀取天氣前先回報進度，讓造訪結束與延後的天氣時間效果從這一格生效。
                # Report progress before reading the weather so visit ends and deferred timing apply from this frame.
                key = boundary_key(schedule, active_preset, frame - playback_start_frame, fps, config["unit_count"])
                playback_advance(
                    0 if last_frame is None else frame - last_frame,
                    round_length(schedule, active_preset, fps, config["unit_count"])[0],
                    key is None or key != last_boundary,
                    not sequence_mode,
                )
            weather = weather_provider() if weather_provider is not None else None
            weather_generation = weather.get("generation") if weather is not None else None
            if weather_generation != last_weather_generation:
                playback_start_frame = frame
                restarted = True
                last_weather_generation = weather_generation
            restarts += restarted
            playback_frame = frame - playback_start_frame
            if show is not None:
                motors = show.motors
            else:
                motors = tuple(motor_provider()) if motor_provider is not None else (("stop", "cw"),) * unit_count
            if len(motors) != unit_count:
                raise ValueError("motor_provider must return one (speed, direction) per unit")
            if last_frame is not None:
                for index, (speed, direction) in enumerate(motors):
                    rpm = 0 if speed == "stop" else motor["rpm"][speed] * (1 if direction == "cw" else -1)
                    phases[index] += (frame - last_frame) * math.tau * (rpm / 60) / fps
            last_frame = frame
            last_boundary = boundary_key(schedule, active_preset, playback_frame, fps, config["unit_count"])
            moon_correction = (moon_correction_provider() if moon_correction_provider is not None
                               else hardware["moon_correction"])
            if playback_reporter is not None:
                playback_reporter(*(("sequence", sequence_state[1]) if sequence_mode else ("single", active_preset)),
                                  restarts, playback_frame)
            # 測試單色時，被指定的燈台整條填色；底下的播放照常前進。
            # A unit colour test fills the chosen units; playback underneath keeps advancing.
            unit_colors = unit_colors_provider() if unit_colors_provider is not None else None
            payloads: dict[int, bytes] = {}
            for target, client in clients:
                unit_id = target["unit_id"]
                if unit_id in payloads:  # 同一台的其他 universe 送同一包。 / Same frame to every universe of a unit.
                    client.send(payloads[unit_id])
                    sent += 1
                    continue
                test_color = unit_colors[unit_id - 1] if unit_colors is not None and unit_id <= len(unit_colors) else None
                category = weather.get("category") if weather is not None else None
                unit = {
                    "unitId": unit_id,
                    "logicalPixelCount": config["pixels"],
                    "frameOffset": (unit_id - 1) * weather["frameStep"] if category == "cloudy" else 0,
                    "virtualPhaseRadians": phases[unit_id - 1],
                }
                color_override = weather.get("color") if category is not None else None
                if test_color is None and show is not None and show.blackout:
                    # 時段外：全 0（燈全暗、馬達停）。 / Outside the show windows: all zero (dark, motor stopped).
                    payloads[unit_id] = blackout_payload()
                    client.send(payloads[unit_id])
                    sent += 1
                    continue
                if test_color is not None:
                    pixels = [test_color] * config["pixels"]
                elif show is not None and show.light <= 0:
                    pixels = [(0.0, 0.0, 0.0)] * config["pixels"]
                elif sequence_mode:
                    pixels = render_sequence_frame(
                        sequence_state[1], unit, playback_frame,
                        unit_count=unit_count, fps=fps, rpm=0,
                        rain=category == "rain", color_override=color_override,
                    )
                else:
                    pixels = render_frame(
                        active_preset,
                        unit, playback_frame, unit_count=unit_count,
                        fps=fps, rpm=0, raining=category == "rain",
                        color_override=color_override,
                    )
                if test_color is None and show is not None and 0 < show.light < 1:
                    pixels = [(r * show.light, g * show.light, b * show.light) for r, g, b in pixels]
                speed, direction = motors[unit_id - 1]
                payloads[unit_id] = build_payload(
                    pixels, hardware=hardware, motor=motor, speed=speed, direction=direction,
                    moon_correction=moon_correction,
                )
                client.send(payloads[unit_id])
                sent += 1
            frame += 1
        return sent
    finally:
        # 結束時每個 universe 送兩次全 0：燈全暗、馬達停。 / On exit: all-zero twice per universe (LEDs off, motor stop).
        blackout = blackout_payload()
        for _ in range(EXIT_BLACKOUT_REPEATS):
            for _, client in clients:
                try:
                    client.send(blackout)
                except OSError:
                    pass
        for _, client in clients:
            client.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Continuous Art-Net effect output")
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().parents[1] / "config.toml")
    parser.add_argument("--seconds", type=float, help="Stop after a duration; otherwise Ctrl+C")
    parser.add_argument("--check", action="store_true", help="Validate TOML and JSON without sending")
    parser.add_argument("--api-only", action="store_true", help="Serve the control API without Art-Net output")
    parser.add_argument("--api-port", type=int, default=8765, help="Preset API port")
    parser.add_argument("--api-host", default="0.0.0.0", help="Page and API bind IPv4 address")
    parser.add_argument("--frontend-dir", type=Path, help="Built frontend directory containing index.html")
    args = parser.parse_args(argv)
    try:
        config, preset = load_config(args.config)
        if not 0 <= args.api_port <= 65535:
            raise ValueError("api port must be 0..65535")
        sequence_path = Path(config["sequence_path"])
        if sequence_path.exists():
            from .sequence import validate_sequence
            validate_sequence(json.loads(sequence_path.read_text(encoding="utf-8")),
                              config["pixels"], config["fps"], config["unit_count"])
        schedule_path = Path(config["schedule_path"])
        if schedule_path.exists():
            from .schedule import validate_schedule
            validate_schedule(json.loads(schedule_path.read_text(encoding="utf-8")), config["unit_count"])
        palette_store = PaletteStore(config["weather"]["palette_path"]) if config["weather"] is not None else None
        if args.check:
            print(f"OK: {preset['effectId']} -> {len(config['targets'])} Art-Net target(s)")
            return 0
        install_stop_handlers()
        store = PresetStore(config["preset_path"], config["pixels"])
        sequence_store = SequenceStore(sequence_path, config["pixels"], config["fps"],
                                       config["unit_count"], store.state(config)["preset"])
        weather_store = (WeatherStore(config["weather"], config["unit_count"], palette=palette_store)
                         if config["weather"] is not None else None)
        default_frontend = Path(__file__).resolve().parents[2] / "frontend" / "dist"
        frontend_dir = args.frontend_dir or (default_frontend if (default_frontend / "index.html").is_file() else None)
        service_label = "Page and API" if frontend_dir else "API"
        playback_monitor = PlaybackMonitor(config["fps"], config["unit_count"])
        unit_color_store = UnitColorStore(config["unit_count"])
        motor_store = MotorStore(config["motor"], config["unit_count"])
        hardware_store = HardwareStore(config["hardware"], config["pixels"])
        schedule_store = ScheduleStore(config["schedule_path"], config["unit_count"])
        scheduler = Scheduler(schedule_store, config["fps"], config["unit_count"])
        with make_server(store, config, args.api_port, host=args.api_host,
                         sequence_store=sequence_store, frontend_dir=frontend_dir,
                         weather_store=weather_store, playback_monitor=playback_monitor,
                         unit_color_store=unit_color_store, motor_store=motor_store,
                         hardware_store=hardware_store, schedule_store=schedule_store,
                         scheduler=scheduler) as server:
            if weather_store is not None:
                weather_store.start()
            try:
                if args.api_only:
                    print(f"{service_label} listening on {args.api_host}:{args.api_port}; Art-Net output is disabled. Ctrl+C to stop.", flush=True)
                    server.serve_forever()
                    return 0
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    print(f"Sending {preset['effectId']} -> {len(config['targets'])} Art-Net target(s) at {config['fps']} FPS. {service_label} listening on {args.api_host}:{args.api_port}. Ctrl+C to stop.", flush=True)
                    sent = stream(config, preset, seconds=args.seconds,
                                  preset_provider=store.snapshot, motor_provider=motor_store.snapshot,
                                  moon_correction_provider=hardware_store.moon_correction,
                                  # 排程啟用時串接一律循環，休息時燈效才能繼續。
                                  # While a timed show is enabled the sequence always loops so rest keeps playing.
                                  sequence_provider=lambda: sequence_store.snapshot(loop=schedule_store.enabled()),
                                  weather_provider=weather_store.snapshot if weather_store is not None else None,
                                  playback_reporter=playback_monitor.report,
                                  playback_advance=weather_store.advance if weather_store is not None else None,
                                  unit_colors_provider=unit_color_store.current,
                                  scheduler=scheduler)
                finally:
                    playback_monitor.stop()
                    scheduler.stop()
                    server.shutdown()
                    worker.join(timeout=2)
            finally:
                if weather_store is not None:
                    weather_store.stop()
        print(f"Stopped after {sent} send calls; delivery is not confirmed.")
        return 0
    except KeyboardInterrupt:
        print("Stopped.")
        return 0
    except (OSError, ValueError, json.JSONDecodeError, tomllib.TOMLDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
