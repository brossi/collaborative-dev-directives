#!/usr/bin/env python3
"""Emit one bounded, privacy-safe E12 host sample from an allowlisted /proc roster."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

MAX_SAFE = 9_007_199_254_740_991
SERVICE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class SampleError(Exception):
    pass


def fail(code: str) -> None:
    raise SampleError(code)


def exact_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            fail("configuration_invalid")
        value[key] = item
    return value


def bounded_integer(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > MAX_SAFE:
        fail("sample_invalid")
    return value


def process_stat(text: str) -> tuple[int, str]:
    close = text.rfind(")")
    fields = text[close + 1 :].strip().split() if close >= 2 else []
    if len(fields) < 20 or not all(fields[index].isdigit() for index in (11, 12, 19)):
        fail("sample_invalid")
    return bounded_integer(int(fields[11]) + int(fields[12])), fields[19]


def resident_bytes(text: str) -> int:
    matches = re.findall(r"^VmRSS:\s+(\d+)\s+kB$", text, re.MULTILINE)
    if len(matches) != 1:
        fail("sample_invalid")
    return bounded_integer(int(matches[0]) * 1024)


def total_cpu_ticks(text: str) -> int:
    fields = text.splitlines()[0].split() if text.splitlines() else []
    if len(fields) < 5 or fields[0] != "cpu" or not all(field.isdigit() for field in fields[1:]):
        fail("sample_invalid")
    return bounded_integer(sum(int(field) for field in fields[1:]))


def read_sample(host_role: str, allowlist: object, proc_root: Path = Path("/proc")) -> dict[str, object]:
    if host_role not in {"application", "source"} or not isinstance(allowlist, dict):
        fail("configuration_invalid")
    if not 1 <= len(allowlist) <= 32:
        fail("configuration_invalid")
    processes: list[dict[str, object]] = []
    for service, expected in allowlist.items():
        if not isinstance(service, str) or not SERVICE.fullmatch(service) or not isinstance(expected, dict):
            fail("configuration_invalid")
        if set(expected) != {"pid", "executable", "cgroup"}:
            fail("configuration_invalid")
        pid = expected["pid"]
        executable = expected["executable"]
        cgroup_expected = expected["cgroup"]
        if (not isinstance(pid, int) or isinstance(pid, bool) or pid < 1
                or not isinstance(executable, str) or not executable.startswith("/")
                or not isinstance(cgroup_expected, str) or not 1 <= len(cgroup_expected) <= 1024):
            fail("configuration_invalid")
        try:
            base = proc_root / str(pid)
            ticks, start_time = process_stat((base / "stat").read_text(encoding="utf-8"))
            cgroup = (base / "cgroup").read_text(encoding="utf-8").strip()
            actual_executable = os.readlink(base / "exe")
            if cgroup != cgroup_expected or actual_executable != executable:
                fail("sample_invalid")
            identity = hashlib.sha256(
                f"{start_time}\0{cgroup}\0{actual_executable}".encode("utf-8")
            ).hexdigest()
            processes.append({
                "service": service,
                "identity": identity,
                "cpuTicks": ticks,
                "rssBytes": resident_bytes((base / "status").read_text(encoding="utf-8")),
            })
        except SampleError:
            raise
        except (OSError, UnicodeError):
            fail("sample_unavailable")
    try:
        total = total_cpu_ticks((proc_root / "stat").read_text(encoding="utf-8"))
    except SampleError:
        raise
    except (OSError, UnicodeError):
        fail("sample_unavailable")
    return {
        "hostRole": host_role,
        "monotonicMs": bounded_integer(time.monotonic_ns() // 1_000_000),
        "totalCpuTicks": total,
        "processes": processes,
    }


def main() -> int:
    try:
        if os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[1] != "--host-role":
            fail("configuration_invalid")
        raw = os.environ.pop("S2F_ALLOWLISTED_PIDS_JSON", "")
        allowlist = json.loads(raw, object_pairs_hook=exact_pairs)
        value = read_sample(sys.argv[2], allowlist)
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        return 0
    except (SampleError, json.JSONDecodeError, OSError) as error:
        code = error.args[0] if isinstance(error, SampleError) else (
            "configuration_invalid" if isinstance(error, json.JSONDecodeError) else "sample_unavailable"
        )
        try:
            sys.stderr.write(f"{code}\n")
        except OSError:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
