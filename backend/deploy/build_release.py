"""Build the minimal Raspberry Pi release artifact (backend + built frontend) from a Git tag.

The archive is assembled from the tagged commit (not the working tree), so it is
reproducible from the tag alone. The frontend is built with `npm ci` and
`npm run build` from the tagged frontend/ sources and shipped under frontend/.
Usage, from the repository root:

    python backend/deploy/build_release.py v0.1.0
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Callable

APP = "moon-observe-backend"
# Keep identical to VERSION_PATTERN in bootstrap.sh and install-release.sh.
VERSION_PATTERN = r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z][0-9A-Za-z.]*)?$"
# Paths relative to backend/ that make up the runtime. Everything else stays out.
RUNTIME_FILES = (
    ".python-version",
    "pyproject.toml",
    "uv.lock",
    "run.py",
    "config.example.toml",
    "preset.example.json",
    "deploy/bootstrap.sh",
    "deploy/install-release.sh",
    "deploy/moon-observe.service",
)
RUNTIME_DIRS = ("moon_observe_backend",)
LF_ONLY_SUFFIXES = (".sh", ".service")


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


def build(repo: Path, version: str, out_dir: Path, force: bool = False,
          frontend_builder: Callable[[Path, str], dict[str, bytes]] = build_frontend) -> tuple[Path, Path]:
    """Write <APP>-<version>.tar.gz and SHA256SUMS into out_dir; return both paths."""
    validate_version(version)
    _git(repo, "rev-parse", "--verify", "--quiet", f"refs/tags/{version}^{{commit}}")
    top = f"{APP}-{version}"
    archive_path = out_dir / f"{top}.tar.gz"
    if archive_path.exists() and not force:
        raise FileExistsError(f"{archive_path} already exists; pass --force to rebuild")

    pathspecs = [f"backend/{path}" for path in (*RUNTIME_FILES, *RUNTIME_DIRS)]
    # autocrlf=false exports blobs exactly as committed, so shell scripts keep LF on Windows.
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
            if relative.endswith(LF_ONLY_SUFFIXES) and b"\r" in data:
                raise ValueError(f"{relative} contains CR line endings")
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

    out_dir.mkdir(parents=True, exist_ok=True)
    directories = {top} | {f"{top}/{'/'.join(name.split('/')[:depth])}"
                           for name in files for depth in range(1, name.count("/") + 1)}
    buffer = io.BytesIO()
    # Fixed gzip mtime, ownership and member order keep rebuilds of a tag byte-identical.
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as target:
            for name in sorted(directories):
                info = tarfile.TarInfo(name)
                info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, mtime
                target.addfile(info)
            for relative in sorted(files):
                data, stamp = files[relative]
                info = tarfile.TarInfo(f"{top}/{relative}")
                info.size, info.mtime = len(data), stamp
                info.mode = 0o755 if relative.endswith(".sh") else 0o644
                target.addfile(info, io.BytesIO(data))
    archive_path.write_bytes(buffer.getvalue())
    digest = hashlib.sha256(buffer.getvalue()).hexdigest()
    sums_path = out_dir / "SHA256SUMS"
    sums_path.write_text(f"{digest}  {archive_path.name}\n", encoding="ascii", newline="\n")
    return archive_path, sums_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the Raspberry Pi release artifact (backend + frontend)")
    parser.add_argument("version", help="Existing Git tag, e.g. v0.1.0")
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
