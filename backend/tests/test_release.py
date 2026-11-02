import hashlib
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

BACKEND = Path(__file__).resolve().parents[1]
DEPLOY = BACKEND / "deploy"
_spec = importlib.util.spec_from_file_location("build_release", DEPLOY / "build_release.py")
build_release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_release)


def fake_frontend(_repo, _version):
    return {"index.html": b"<!doctype html>", "palette.html": b"<!doctype html>", "assets/app.js": b"app"}


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.invalid", *args],
                   check=True, capture_output=True)


class VersionTests(unittest.TestCase):
    def test_accepts_release_and_prerelease_tags(self):
        for version in ("v0.1.0", "v1.20.3", "v1.2.0-rc.1"):
            self.assertEqual(build_release.validate_version(version), version)

    def test_rejects_unsafe_or_loose_versions(self):
        for version in ("0.1.0", "v1.2", "v01.2.3", "v1.2.3/../x", "v1.2.3-", "v1.2.3 "):
            with self.assertRaises(ValueError):
                build_release.validate_version(version)

    def test_shell_scripts_share_the_version_pattern(self):
        line = f"VERSION_PATTERN='{build_release.VERSION_PATTERN}'"
        for script in ("bootstrap.sh", "install-release.sh"):
            self.assertIn(line, (DEPLOY / script).read_text(encoding="utf-8").splitlines(), script)

    def test_service_serves_the_release_frontend(self):
        unit = (DEPLOY / "moon-observe.service").read_text(encoding="utf-8")
        self.assertIn("--frontend-dir @INSTALL_ROOT@/current/frontend", unit)

    def test_deploy_scripts_use_lf(self):
        for name in ("bootstrap.sh", "install-release.sh", "moon-observe.service"):
            self.assertNotIn(b"\r", (DEPLOY / name).read_bytes(), name)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)
        self.repo = self.temp / "repo"
        backend = self.repo / "backend"
        for relative in build_release.RUNTIME_FILES:
            (backend / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(BACKEND / relative, backend / relative)
        shutil.copytree(BACKEND / "moon_observe_backend", backend / "moon_observe_backend",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (backend / "tests").mkdir()
        (backend / "tests" / "test_x.py").write_text("", encoding="utf-8")
        (backend / "config.toml").write_text("local = true\n", encoding="utf-8")
        git(self.repo, "init", "-q")
        git(self.repo, "config", "core.autocrlf", "false")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "release")
        git(self.repo, "tag", "v0.1.0")
        self.out = self.temp / "dist"

    def test_archive_contains_only_the_tagged_runtime(self):
        (self.repo / "backend" / "run.py").write_text("# untagged change\n", encoding="utf-8")
        archive, sums = build_release.build(self.repo, "v0.1.0", self.out, frontend_builder=fake_frontend)
        top = "moon-observe-backend-v0.1.0"
        self.assertEqual(archive.name, f"{top}.tar.gz")
        with tarfile.open(archive) as bundle:
            members = {member.name: member for member in bundle.getmembers()}
            files = {name.removeprefix(f"{top}/") for name, member in members.items() if member.isfile()}
            self.assertTrue(all(name == top or name.startswith(f"{top}/") for name in members))
            self.assertEqual(bundle.extractfile(f"{top}/VERSION").read(), b"v0.1.0\n")
            self.assertNotEqual(bundle.extractfile(f"{top}/run.py").read(), b"# untagged change\n")
            self.assertEqual(members[f"{top}/deploy/install-release.sh"].mode, 0o755)
            self.assertEqual(members[f"{top}/run.py"].mode, 0o644)
            self.assertTrue(all(member.uid == 0 and member.gid == 0 for member in members.values()))
        self.assertTrue(set(build_release.RUNTIME_FILES) <= files)
        self.assertIn("moon_observe_backend/output.py", files)
        self.assertTrue({"frontend/index.html", "frontend/palette.html", "frontend/assets/app.js"} <= files)
        self.assertFalse({"config.toml", "tests/test_x.py"} & files)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual(sums.read_text(encoding="ascii"), f"{digest}  {archive.name}\n")

    def test_rebuild_requires_force_and_is_reproducible(self):
        archive, _ = build_release.build(self.repo, "v0.1.0", self.out, frontend_builder=fake_frontend)
        first = archive.read_bytes()
        with self.assertRaises(FileExistsError):
            build_release.build(self.repo, "v0.1.0", self.out, frontend_builder=fake_frontend)
        build_release.build(self.repo, "v0.1.0", self.out, force=True, frontend_builder=fake_frontend)
        self.assertEqual(archive.read_bytes(), first)

    def test_frontend_without_index_fails(self):
        with self.assertRaises(FileNotFoundError):
            build_release.build(self.repo, "v0.1.0", self.out, frontend_builder=lambda _repo, _version: {"a.js": b""})

    def test_missing_tag_fails(self):
        with self.assertRaises(RuntimeError):
            build_release.build(self.repo, "v9.9.9", self.out, frontend_builder=fake_frontend)

    def test_crlf_shell_script_fails(self):
        script = self.repo / "backend" / "deploy" / "bootstrap.sh"
        script.write_bytes(script.read_bytes().replace(b"\n", b"\r\n"))
        git(self.repo, "commit", "-qam", "crlf")
        git(self.repo, "tag", "v0.2.0")
        with self.assertRaises(ValueError):
            build_release.build(self.repo, "v0.2.0", self.out, frontend_builder=fake_frontend)


if __name__ == "__main__":
    unittest.main()
