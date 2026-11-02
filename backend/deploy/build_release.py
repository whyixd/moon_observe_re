"""Build the Windows release artifact (backend + built frontend + WinSW) from a Git tag.

The zip is assembled from the tagged commit (not the working tree), so it is reproducible from the
tag alone. The frontend is built with `npm ci` and `npm run build` from the tagged frontend/ sources
and shipped under frontend/. WinSW (the service wrapper) is downloaded once, pinned by SHA-256 and
shipped as deploy/winsw/WinSW.exe. Usage, from the repository root:

    python backend/deploy/build_release.py v0.2.0
"""

from __future__ import annotations

import argparse
import hashlib
import io
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import Callable
import urllib.request
import zipfile

APP = "moon-observe"
# Keep identical to $VersionPattern in bootstrap.ps1 and install-release.ps1.
VERSION_PATTERN = r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z][0-9A-Za-z.]*)?$"
# Paths relative to backend/ that make up the runtime. Everything else stays out.
RUNTIME_FILES = (
    ".python-version",
    "pyproject.toml",
    "uv.lock",
    "run.py",
    "config.example.toml",
    "preset.example.json",
    "deploy/bootstrap.ps1",
    "deploy/install-release.ps1",
    "deploy/uninstall.ps1",
    "deploy/moon-observe.xml",
)
RUNTIME_DIRS = ("moon_observe_backend",)
# Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page, so scripts must be plain ASCII.
ASCII_ONLY_SUFFIXES = (".ps1",)
# WinSW 2.12.0 for .NET Framework 4.6.1 (Windows 10 ships 4.8). GitHub publishes no digest; this one
# was taken from the release asset on 2026-11-03 and pins every later download.
WINSW_URL = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe"
WINSW_SHA256 = "b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f"
WINSW_PATH = "deploy/winsw/WinSW.exe"
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)  # the earliest timestamp a zip entry can hold


def validate_version(version: str) -> str:
    if not re.fullmatch(VERSION_PATTERN, version):
        raise ValueError(f"version must look like v1.2.3 or v1.2.3-rc.1, got {version!r}")
    return version


def _git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def _excluded(relative: str) -> bool:
    parts = relative.split("/")
    return "__pycache__" in parts or relative.endswith(".pyc")


def build_frontend(repo: Path, version: str) -> dict[str, bytes]:
    """Build the tagged frontend/ with npm; return dist files keyed by relative path."""
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError("npm is required to build the frontend")
    raw = _git(repo, "-c", "core.autocrlf=false", "archive", "--format=tar", version, "--", "frontend")
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
            source.extractall(root, filter="data")
        project = root / "frontend"
        for args in (("ci", "--no-audit", "--no-fund"), ("run", "build")):
            result = subprocess.run([npm, *args], cwd=project, capture_output=True, check=False)
            if result.returncode != 0:
                output = (result.stdout + result.stderr).decode(errors="replace").strip()
                raise RuntimeError(f"npm {' '.join(args)} failed:\n{output[-2000:]}")
        dist = project / "dist"
        return {path.relative_to(dist).as_posix(): path.read_bytes()
                for path in sorted(dist.rglob("*")) if path.is_file()}


def fetch_winsw(cache_dir: Path) -> bytes:
    """WinSW from the local cache, downloading it once; the pinned digest is checked by build()."""
    cached = cache_dir / Path(WINSW_URL).name
    if not cached.is_file() or hashlib.sha256(cached.read_bytes()).hexdigest() != WINSW_SHA256:
        cache_dir.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(WINSW_URL, timeout=60) as response:
            cached.write_bytes(response.read())
    return cached.read_bytes()


def _zip_time(stamp: int) -> tuple[int, int, int, int, int, int]:
    return max(ZIP_EPOCH, tuple(time.gmtime(stamp)[:6]))


def build(repo: Path, version: str, out_dir: Path, force: bool = False,
          frontend_builder: Callable[[Path, str], dict[str, bytes]] = build_frontend,
          winsw: bytes | None = None, winsw_sha256: str = WINSW_SHA256) -> tuple[Path, Path]:
    """Write <APP>-<version>-windows.zip and SHA256SUMS into out_dir; return both paths."""
    validate_version(version)
    _git(repo, "rev-parse", "--verify", "--quiet", f"refs/tags/{version}^{{commit}}")
    top = f"{APP}-{version}"
    archive_path = out_dir / f"{top}-windows.zip"
    if archive_path.exists() and not force:
        raise FileExistsError(f"{archive_path} already exists; pass --force to rebuild")

    pathspecs = [f"backend/{path}" for path in (*RUNTIME_FILES, *RUNTIME_DIRS)]
    # autocrlf=false exports blobs exactly as committed.
    raw = _git(repo, "-c", "core.autocrlf=false", "archive", "--format=tar", version, "--", *pathspecs)

    files: dict[str, tuple[bytes, int]] = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        for member in source.getmembers():
            if not member.isfile():
                continue
            relative = member.name.removeprefix("backend/")
            if _excluded(relative):
                continue
            data = source.extractfile(member).read()
            if relative.endswith(ASCII_ONLY_SUFFIXES) and not data.isascii():
                raise ValueError(f"{relative} must be plain ASCII (Windows PowerShell 5.1 reads it as ANSI)")
            files[relative] = (data, member.mtime)
    missing = [path for path in RUNTIME_FILES if path not in files]
    missing += [path for path in RUNTIME_DIRS if not any(name.startswith(f"{path}/") for name in files)]
    if missing:
        raise FileNotFoundError(f"tag {version} is missing runtime files: {', '.join(missing)}")
    mtime = max(stamp for _, stamp in files.values())
    files["VERSION"] = (f"{version}\n".encode(), mtime)
    frontend = frontend_builder(repo, version)
    if "index.html" not in frontend:
        raise FileNotFoundError("frontend build produced no index.html")
    for relative, data in frontend.items():
        files[f"frontend/{relative}"] = (data, mtime)
    winsw = fetch_winsw(repo / "dist" / ".cache") if winsw is None else winsw
    if hashlib.sha256(winsw).hexdigest() != winsw_sha256:
        raise ValueError(f"WinSW does not match the pinned SHA-256 {winsw_sha256}")
    files[WINSW_PATH] = (winsw, mtime)

    out_dir.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    # Fixed timestamps, attributes and member order keep rebuilds of a tag byte-identical.
    with zipfile.ZipFile(buffer, "w") as target:
        for relative in sorted(files):
            data, stamp = files[relative]
            info = zipfile.ZipInfo(f"{top}/{relative}", date_time=_zip_time(stamp))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 0
            info.external_attr = 0
            target.writestr(info, data, compresslevel=9)
    archive_path.write_bytes(buffer.getvalue())
    digest = hashlib.sha256(buffer.getvalue()).hexdigest()
    sums_path = out_dir / "SHA256SUMS"
    sums_path.write_text(f"{digest}  {archive_path.name}\n", encoding="ascii", newline="\n")
    return archive_path, sums_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the Windows release artifact (backend + frontend + WinSW)")
    parser.add_argument("version", help="Existing Git tag, e.g. v0.2.0")
    parser.add_argument("--out", type=Path, help="Output directory (default: <repo>/dist)")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing archive")
    args = parser.parse_args(argv)
    try:
        repo = Path(_git(Path(__file__).resolve().parent, "rev-parse", "--show-toplevel").decode().strip())
        archive, sums = build(repo, args.version, args.out or repo / "dist", args.force)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(f"Built {archive}\nWrote {sums}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
