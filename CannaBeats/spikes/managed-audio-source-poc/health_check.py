#!/usr/bin/env python3
"""Emit a secret-free component and capacity report for the managed source."""

import json
import socket
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request


CORE_SERVICES = (
    "cannabeats-display.service",
    "cannabeats-audio.service",
    "cannabeats-source-agent.service",
    "cannabeats-source-controller.service",
    "cannabeats-browser.service",
)


def service_state(name):
    try:
        result = subprocess.run(
            ["/usr/bin/systemctl", "is-active", name],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        state = result.stdout.strip()
        return state if state in {"active", "inactive", "failed", "activating", "deactivating"} else "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def fetch_json(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            if response.status != 200:
                return {"status": "unavailable", "reasonCode": f"http_{response.status}"}
            body = response.read(65_537)
            if len(body) > 65_536:
                return {"status": "unavailable", "reasonCode": "response_too_large"}
            payload = json.loads(body)
            return payload if isinstance(payload, dict) else {
                "status": "unavailable", "reasonCode": "response_invalid",
            }
    except urllib.error.HTTPError as error:
        return {"status": "unavailable", "reasonCode": f"http_{error.code}"}
    except (TimeoutError, socket.timeout):
        return {"status": "unavailable", "reasonCode": "timeout"}
    except (ValueError, json.JSONDecodeError):
        return {"status": "unavailable", "reasonCode": "response_invalid"}
    except Exception:
        return {"status": "unavailable", "reasonCode": "connection_failed"}


def configuration_check(get_json=fetch_json):
    payload = get_json("http://127.0.0.1:4781/config")
    if payload.get("status") == "unavailable" and "reasonCode" in payload:
        return payload
    client_id = payload.get("spotifyClientId")
    redirect_uri = payload.get("spotifyRedirectUri")
    if (
        isinstance(client_id, str) and client_id.strip()
        and isinstance(redirect_uri, str)
        and redirect_uri.startswith("https://")
        and redirect_uri.endswith("/spotify/callback")
    ):
        return {"status": "healthy", "reasonCode": "configuration_valid"}
    return {"status": "unavailable", "reasonCode": "configuration_invalid"}


def _safe_state(value, allowed):
    if not isinstance(value, dict):
        return {"status": "unknown", "reasonCode": "controller_contract_invalid"}
    pair = (value.get("status"), value.get("reasonCode"))
    return value if pair in allowed else {
        "status": "unknown", "reasonCode": "controller_contract_invalid",
    }


def controller_checks(get_json=fetch_json):
    payload = get_json("http://127.0.0.1:4782/state")
    if payload.get("status") == "unavailable" and "reasonCode" in payload:
        return {
            "gameApi": {"status": "unavailable", "reasonCode": "controller_state_unavailable"},
            "spotifyAuthorization": {"status": "unknown", "reasonCode": "controller_state_unavailable"},
            "player": {"status": "unknown", "reasonCode": "controller_state_unavailable"},
        }
    browser = payload.get("browserReadiness")
    browser = browser if isinstance(browser, dict) else {}
    return {
        "gameApi": _safe_state(payload.get("gameApi"), {
            ("healthy", "authenticated_poll_succeeded"),
            ("unavailable", "game_api_unavailable"),
            ("unknown", "awaiting_first_poll"),
        }),
        "spotifyAuthorization": _safe_state(browser.get("spotifyAuthorization"), {
            ("healthy", "spotify_authorized"),
            ("degraded", "spotify_not_authorized"),
            ("degraded", "spotify_authorization_error"),
            ("unknown", "browser_not_reported"),
            ("unknown", "browser_report_stale"),
        }),
        "player": _safe_state(browser.get("player"), {
            ("healthy", "player_ready"),
            ("degraded", "player_not_ready"),
            ("degraded", "player_error"),
            ("unknown", "browser_not_reported"),
            ("unknown", "browser_report_stale"),
        }),
    }


def memory_available_percent():
    values = {}
    with open("/proc/meminfo", encoding="utf-8") as meminfo:
        for line in meminfo:
            key, value = line.split(":", 1)
            values[key] = int(value.strip().split()[0])
    return round(values["MemAvailable"] * 100 / values["MemTotal"], 2)


def disk_check(disk_usage=shutil.disk_usage):
    try:
        disk = disk_usage("/")
        available = round(disk.free * 100 / disk.total, 2)
        return {
            "status": "degraded" if available < 10 else "healthy",
            "reasonCode": "capacity_low" if available < 10 else "capacity_available",
            "percentAvailable": available,
        }
    except Exception:
        return {"status": "unknown", "reasonCode": "capacity_unavailable"}


def memory_check(available_percent=memory_available_percent):
    try:
        available = available_percent()
        return {
            "status": "degraded" if available < 10 else "healthy",
            "reasonCode": "capacity_low" if available < 10 else "capacity_available",
            "percentAvailable": available,
        }
    except Exception:
        return {"status": "unknown", "reasonCode": "capacity_unavailable"}


def overall_status(checks):
    unavailable = (
        any(state != "active" for state in checks["services"].values())
        or checks["configuration"]["status"] == "unavailable"
        or checks["gameApi"]["status"] == "unavailable"
        or checks["relayPublisher"]["status"] == "unavailable"
    )
    degraded = any(checks[name]["status"] != "healthy" for name in (
        "gameApi", "spotifyAuthorization", "player", "disk", "memory",
    ))
    return "unavailable" if unavailable else "degraded" if degraded else "healthy"


def report():
    services = {name: service_state(name) for name in CORE_SERVICES}
    relay = service_state("cannabeats-relay-push.service")
    configuration = configuration_check()
    controller = controller_checks()
    disk = disk_check()
    memory = memory_check()
    checks = {
        "services": services,
        "configuration": configuration,
        "gameApi": controller["gameApi"],
        "spotifyAuthorization": controller["spotifyAuthorization"],
        "player": controller["player"],
        "relayPublisher": {
            "status": "healthy" if relay == "active" else "idle" if relay == "inactive" else "unavailable",
            "reasonCode": "lease_active" if relay == "active" else "no_active_lease" if relay == "inactive" else "service_failure",
        },
        "disk": disk,
        "memory": memory,
        "transferUsage": {
            "status": "unknown",
            "reasonCode": "provider_control_plane_required",
        },
    }
    status = overall_status(checks)
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
