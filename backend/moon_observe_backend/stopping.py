"""Turn every stop request into one KeyboardInterrupt, so the output loop always runs its exit path
(the all-zero frame that turns the LEDs off and stops the motors).

停止要求一律轉成一次 KeyboardInterrupt，確保結束時送出全 0（關燈、馬達停）。

- SIGINT (Ctrl+C) is handled even when the parent started us with it ignored (a background job in a
  non-interactive shell inherits SIG_IGN, and Python then never raises KeyboardInterrupt).
- SIGTERM (kill, most service managers) and, on Windows, SIGBREAK (Ctrl+Break) stop the same way.
- On Windows the console Ctrl+C processing is re-enabled, in case a service wrapper created the
  process with it disabled (CREATE_NEW_PROCESS_GROUP).
- After the first request further ones are ignored, so a repeated Ctrl+C cannot cut the exit frame short.
"""

from __future__ import annotations

import os
import signal
from types import FrameType

STOP_SIGNALS = tuple(getattr(signal, name) for name in ("SIGINT", "SIGTERM", "SIGBREAK") if hasattr(signal, name))


def _stop(_signum: int, _frame: FrameType | None) -> None:
    for stop_signal in STOP_SIGNALS:
        signal.signal(stop_signal, signal.SIG_IGN)
    raise KeyboardInterrupt


def install_stop_handlers() -> None:
    """Call once from the main thread before serving and streaming."""
    if os.name == "nt":
        import ctypes

        ctypes.windll.kernel32.SetConsoleCtrlHandler(None, False)
    for stop_signal in STOP_SIGNALS:
        signal.signal(stop_signal, _stop)
