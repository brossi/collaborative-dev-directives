#!/usr/bin/env python3
"""Emit a secret-free component and capacity report for the managed source."""

import json
import shutil
import subprocess
import sys
import time
import urllib.request


CORE_SERVICES = (
    "cannabeats-display.service",
    "cannabeats-audio.service",
    "cannabeats-source-agent.service",
    "cannabeats-source-controller.service",
    "cannabeats-browser.service",
)


def service_state(name):
    result = subprocess.run(
        ["/usr/bin/systemctl", "is-active", name],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    state = result.stdout.strip()
    return state if state in {"active", "inactive", "failed", "activating", "deactivating"} else "unknown"


def endpoint(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return "healthy" if response.status == 200 else "unavailable"
    except Exception:
        return "unavailable"


def memory_available_percent():
    values = {}
    with open("/proc/meminfo", encoding="utf-8") as meminfo:
        for line in meminfo:
            key, value = line.split(":", 1)
            values[key] = int(value.strip().split()[0])
    return round(values["MemAvailable"] * 100 / values["MemTotal"], 2)


def report():
    services = {name: service_state(name) for name in CORE_SERVICES}
    relay = service_state("cannabeats-relay-push.service")
    disk = shutil.disk_usage("/")
    disk_available = round(disk.free * 100 / disk.total, 2)
    memory_available = memory_available_percent()
    checks = {
        "services": services,
        "sourceUi": {"status": endpoint("http://127.0.0.1:4781/health")},
        "sourceController": {"status": endpoint("http://127.0.0.1:4782/health")},
        "relayPublisher": {
            "status": "healthy" if relay == "active" else "idle" if relay == "inactive" else "unavailable",
            "reasonCode": "lease_active" if relay == "active" else "no_active_lease" if relay == "inactive" else "service_failure",
        },
        "disk": {
            "status": "degraded" if disk_available < 10 else "healthy",
            "percentAvailable": disk_available,
        },
        "memory": {
            "status": "degraded" if memory_available < 10 else "healthy",
            "percentAvailable": memory_available,
        },
        "transferUsage": {
            "status": "unknown",
            "reasonCode": "provider_control_plane_required",
        },
    }
    unavailable = (
        any(state != "active" for state in services.values())
        or checks["sourceUi"]["status"] != "healthy"
        or checks["sourceController"]["status"] != "healthy"
    )
    degraded = disk_available < 10 or memory_available < 10
    status = "unavailable" if unavailable else "degraded" if degraded else "healthy"
    return {
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "service": "managed-source",
        "status": status,
        "components": checks,
    }


if __name__ == "__main__":
    result = report()
    print(json.dumps(result, separators=(",", ":")))
    sys.exit(1 if result["status"] == "unavailable" else 2 if result["status"] == "degraded" else 0)
