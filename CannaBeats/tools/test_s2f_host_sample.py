import importlib.util
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("s2f-host-sample.py")
SPEC = importlib.util.spec_from_file_location("s2f_host_sample", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class HostSampleTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        process = root / "42"
        process.mkdir()
        (root / "stat").write_text("cpu 100 2 3 400 5 6 7 8 9 10\n", encoding="utf-8")
        (process / "stat").write_text(
            "42 (source worker) R 1 1 1 1 1 1 1 1 1 1 20 5 0 0 0 0 0 0 777 0\n",
            encoding="utf-8",
        )
        (process / "status").write_text("Name:\tsource\nVmRSS:\t123 kB\n", encoding="utf-8")
        (process / "cgroup").write_text("0::/system.slice/cannabeats-source.service\n", encoding="utf-8")
        (process / "exe").symlink_to("/usr/bin/python3")
        allowlist = {"source": {
            "pid": 42,
            "executable": "/usr/bin/python3",
            "cgroup": "0::/system.slice/cannabeats-source.service",
        }}
        return temporary, root, allowlist

    def test_cross_uid_root_sampler_emits_only_stable_allowlisted_scalars(self):
        temporary, root, allowlist = self.fixture()
        self.addCleanup(temporary.cleanup)
        with patch.object(MODULE.time, "monotonic_ns", return_value=5_000_000_000):
            sample = MODULE.read_sample("source", allowlist, root)
        self.assertEqual(sample["monotonicMs"], 5000)
        self.assertEqual(sample["totalCpuTicks"], 550)
        self.assertEqual(sample["processes"][0]["cpuTicks"], 25)
        self.assertEqual(sample["processes"][0]["rssBytes"], 125952)
        self.assertEqual(
            sample["processes"][0]["identity"],
            "1a66c948e6ccba6919f1e00eaf36aa757cd3cbe06dcb22866a29c394d10026b1",
        )
        serialized = json.dumps(sample)
        self.assertNotIn("/proc", serialized)
        self.assertNotIn("python3", serialized)
        self.assertNotIn('"pid"', serialized)

    def test_substituted_executable_and_extra_configuration_fail_finitely(self):
        temporary, root, allowlist = self.fixture()
        self.addCleanup(temporary.cleanup)
        changed = json.loads(json.dumps(allowlist))
        changed["source"]["executable"] = "/usr/bin/other"
        with self.assertRaisesRegex(MODULE.SampleError, "sample_invalid"):
            MODULE.read_sample("source", changed, root)
        changed = json.loads(json.dumps(allowlist))
        changed["source"]["extra"] = "caller"
        with self.assertRaisesRegex(MODULE.SampleError, "configuration_invalid"):
            MODULE.read_sample("source", changed, root)

    def test_cli_requires_root_before_reading_private_configuration(self):
        with patch.object(MODULE.os, "geteuid", return_value=1000), patch.object(
            MODULE.sys, "argv", [str(MODULE_PATH), "--host-role", "source"]
        ), patch.dict(os.environ, {"S2F_ALLOWLISTED_PIDS_JSON": "{}"}, clear=False), redirect_stderr(
            StringIO()
        ) as errors:
            self.assertEqual(MODULE.main(), 1)
            self.assertEqual(errors.getvalue(), "configuration_invalid\n")


if __name__ == "__main__":
    unittest.main()
