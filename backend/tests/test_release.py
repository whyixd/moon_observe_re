import hashlib
import importlib.util
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree
import zipfile

BACKEND = Path(__file__).resolve().parents[1]
DEPLOY = BACKEND / "deploy"
_spec = importlib.util.spec_from_file_location("build_release", DEPLOY / "build_release.py")
build_release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_release)

SCRIPTS = ("bootstrap.ps1", "install-release.ps1", "uninstall.ps1")
FAKE_WINSW = b"MZ fake winsw"


def fake_frontend(_repo, _version):
    return {"index.html": b"<!doctype html>", "palette.html": b"<!doctype html>", "assets/app.js": b"app"}


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.invalid", *args],
                   check=True, capture_output=True)


def script(name):
    return (DEPLOY / name).read_text(encoding="ascii")


def code_lines(name):
    """Script lines without comment-only lines and without the <# ... #> help block."""
    text = re.sub(r"<#.*?#>", "", script(name), flags=re.S)
    return [line for line in text.splitlines() if not line.lstrip().startswith("#")]


class VersionTests(unittest.TestCase):
    def test_accepts_release_and_prerelease_tags(self):
        for version in ("v0.1.0", "v1.20.3", "v1.2.0-rc.1"):
            self.assertEqual(build_release.validate_version(version), version)

    def test_rejects_unsafe_or_loose_versions(self):
        for version in ("0.1.0", "v1.2", "v01.2.3", "v1.2.3/../x", "v1.2.3-", "v1.2.3 ", "V1.2.3"):
            with self.assertRaises(ValueError):
                build_release.validate_version(version)

    def test_scripts_share_the_version_pattern_case_sensitively(self):
        line = f"$VersionPattern = '{build_release.VERSION_PATTERN}'"
        for name in ("bootstrap.ps1", "install-release.ps1"):
            self.assertIn(line, script(name).splitlines(), name)
            # -match is case-insensitive in PowerShell; V1.2.3 must not pass.
            self.assertIn("$Version -cnotmatch $VersionPattern", script(name), name)


class WindowsScriptTests(unittest.TestCase):
    """Static checks; the scripts run on Windows PowerShell 5.1 and are exercised on site (deploy/README.md)."""

    def test_scripts_are_ascii_without_bom(self):
        for name in (*SCRIPTS, "moon-observe.xml"):
            data = (DEPLOY / name).read_bytes()
            self.assertTrue(data.isascii(), name)
            self.assertFalse(data.startswith(b"\xef\xbb\xbf"), name)

    def test_no_powershell_7_only_syntax(self):
        for name in SCRIPTS:
            for number, line in enumerate(code_lines(name), 1):
                for token in ("??", "?.", "&&", "||", "-Parallel", "-AsHashtable", "Get-Error"):
                    self.assertNotIn(token, line, f"{name}:{number}: {line}")
                self.assertIsNone(re.search(r"\s\?\s.*\s:\s", line), f"{name}:{number}: ternary? {line}")

    def test_web_requests_use_basic_parsing(self):
        for name in SCRIPTS:
            for line in code_lines(name):
                if re.search(r"Invoke-(WebRequest|RestMethod)\b", line):
                    self.assertIn("-UseBasicParsing", line, f"{name}: {line}")

    def test_strict_and_stop_on_error(self):
        for name in SCRIPTS:
            self.assertIn("Set-StrictMode -Version 2.0", script(name), name)
            self.assertIn("$ErrorActionPreference = 'Stop'", script(name), name)

    def test_downloads_enable_tls12(self):
        for name in ("bootstrap.ps1", "install-release.ps1"):
            self.assertIn("[Net.SecurityProtocolType]::Tls12", script(name), name)

    def test_names_agree_across_scripts_and_template(self):
        template = (DEPLOY / "moon-observe.xml").read_text(encoding="ascii")
        self.assertIn("<id>MoonObserve</id>", template)
        for name in ("install-release.ps1", "uninstall.ps1"):
            self.assertIn("$ServiceName = 'MoonObserve'", script(name), name)
            self.assertIn("$FirewallRule = 'MoonObserve-TCP-8765'", script(name), name)
        self.assertIn(f"'deploy\\winsw\\WinSW.exe'", script("install-release.ps1"))
        self.assertEqual("deploy/winsw/WinSW.exe", build_release.WINSW_PATH)
        self.assertIn('"moon-observe-$Version-windows.zip"', script("bootstrap.ps1"))
        self.assertIn('"$App-$Version"', script("install-release.ps1"))
        self.assertIn('"$Top-windows.zip"', script("install-release.ps1"))
        self.assertEqual("moon-observe", build_release.APP)

    def test_template_placeholders_are_all_filled_and_give_valid_xml(self):
        template = (DEPLOY / "moon-observe.xml").read_text(encoding="ascii")
        self.assertEqual({"@INSTALL_ROOT@", "@DATA_ROOT@", "@PORT@"}, set(re.findall(r"@[A-Z_]+@", template)))
        installer = " ".join(script("install-release.ps1").split())
        for replacement in ("Replace('@INSTALL_ROOT@', $InstallRoot)", "Replace( '@DATA_ROOT@', $DataRoot)",
                            "Replace('@PORT@', [string]$Port)"):
            self.assertIn(replacement, installer)
        filled = template.replace("@INSTALL_ROOT@", r"C:\MoonObserve").replace(
            "@DATA_ROOT@", r"C:\ProgramData\MoonObserve").replace("@PORT@", "8765")
        root = ElementTree.fromstring(filled)
        self.assertEqual(r"C:\MoonObserve\current\.venv\Scripts\python.exe", root.findtext("executable"))
        self.assertEqual(r"C:\MoonObserve\current", root.findtext("workingdirectory"))
        arguments = root.findtext("arguments")
        self.assertIn(r'--config "C:\ProgramData\MoonObserve\config.toml"', arguments)
        self.assertIn(r'--frontend-dir "C:\MoonObserve\current\frontend"', arguments)
        self.assertIn("--api-port 8765", arguments)
        self.assertEqual(r"C:\ProgramData\MoonObserve\logs", root.findtext("logpath"))
        self.assertEqual("15 sec", root.findtext("stoptimeout"))

    def test_seeded_config_rewrites_match_the_example_exactly_once(self):
        # install-release.ps1 points preset, sequence and the palette comment into the writable preset\ folder.
        example = (BACKEND / "config.example.toml").read_text(encoding="utf-8")
        for pattern in (r"^preset = .*$", r"^sequence = .*$", r'^# palette = "palette.json"'):
            self.assertEqual(1, len(re.findall(pattern, example, flags=re.M)), pattern)
            self.assertIn(pattern.replace("\\", ""), script("install-release.ps1").replace("\\", ""))

    def test_uv_is_pinned(self):
        text = script("bootstrap.ps1")
        self.assertRegex(text, r"\$UvVersion = '\d+\.\d+\.\d+'")
        self.assertRegex(text, r"\$UvSha256 = '[0-9a-f]{64}'")
        self.assertRegex(build_release.WINSW_SHA256, r"^[0-9a-f]{64}$")

    def test_junction_is_removed_without_recursion(self):
        # Remove-Item -Recurse on a junction can delete the release behind it in Windows PowerShell 5.1.
        for name in ("install-release.ps1", "uninstall.ps1"):
            self.assertIn("[IO.Directory]::Delete($", script(name), name)
            self.assertNotIn("Remove-Item -LiteralPath $Current", script(name), name)


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

    def build(self, version="v0.1.0", **kwargs):
        kwargs.setdefault("winsw", FAKE_WINSW)
        kwargs.setdefault("winsw_sha256", hashlib.sha256(FAKE_WINSW).hexdigest())
        return build_release.build(self.repo, version, self.out, frontend_builder=fake_frontend, **kwargs)

    def test_archive_contains_only_the_tagged_runtime(self):
        (self.repo / "backend" / "run.py").write_text("# untagged change\n", encoding="utf-8")
        archive, sums = self.build()
        top = "moon-observe-v0.1.0"
        self.assertEqual(f"{top}-windows.zip", archive.name)
        with zipfile.ZipFile(archive) as bundle:
            names = bundle.namelist()
            self.assertEqual(sorted(names), names)
            self.assertTrue(all(name.startswith(f"{top}/") and ".." not in name.split("/") for name in names))
            self.assertEqual(b"v0.1.0\n", bundle.read(f"{top}/VERSION"))
            self.assertNotEqual(b"# untagged change\n", bundle.read(f"{top}/run.py"))
            self.assertEqual(FAKE_WINSW, bundle.read(f"{top}/deploy/winsw/WinSW.exe"))
            self.assertTrue(all(info.compress_type == zipfile.ZIP_DEFLATED for info in bundle.infolist()))
        files = {name.removeprefix(f"{top}/") for name in names}
        self.assertTrue(set(build_release.RUNTIME_FILES) <= files)
        self.assertIn("moon_observe_backend/output.py", files)
        self.assertTrue({"frontend/index.html", "frontend/palette.html", "frontend/assets/app.js"} <= files)
        self.assertFalse({"config.toml", "tests/test_x.py"} & files)
        self.assertFalse(any(name.endswith((".sh", ".service")) for name in files))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual(f"{digest}  {archive.name}\n", sums.read_text(encoding="ascii"))

    def test_rebuild_requires_force_and_is_reproducible(self):
        archive, _ = self.build()
        first = archive.read_bytes()
        with self.assertRaises(FileExistsError):
            self.build()
        self.build(force=True)
        self.assertEqual(first, archive.read_bytes())

    def test_winsw_must_match_the_pinned_digest(self):
        with self.assertRaisesRegex(ValueError, "WinSW"):
            self.build(winsw=b"tampered")

    def test_frontend_without_index_fails(self):
        with self.assertRaises(FileNotFoundError):
            build_release.build(self.repo, "v0.1.0", self.out, frontend_builder=lambda _repo, _version: {"a.js": b""},
                                winsw=FAKE_WINSW, winsw_sha256=hashlib.sha256(FAKE_WINSW).hexdigest())

    def test_missing_tag_fails(self):
        with self.assertRaises(RuntimeError):
            self.build("v9.9.9")

    def test_non_ascii_powershell_script_fails(self):
        installer = self.repo / "backend" / "deploy" / "install-release.ps1"
        installer.write_text(installer.read_text(encoding="ascii") + "# \u4e2d\u6587\n", encoding="utf-8")
        git(self.repo, "commit", "-qam", "non-ascii")
        git(self.repo, "tag", "v0.2.0")
        with self.assertRaisesRegex(ValueError, "ASCII"):
            self.build("v0.2.0")


if __name__ == "__main__":
    unittest.main()
