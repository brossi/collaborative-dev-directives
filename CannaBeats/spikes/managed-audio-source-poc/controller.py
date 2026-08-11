#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

API_URL = os.environ.get(
    "CANNABEATS_AUDIO_SOURCE_API",
    "https://poc.cannabeats.social/game/api/audio-source",
)
TOKEN_PATH = Path(os.environ.get(
    "CANNABEATS_AUDIO_SOURCE_TOKEN_FILE",
    "/etc/cannabeats-managed-source/source-token",
))
LISTEN_ADDRESS = ("127.0.0.1", 4782)
BROWSER_ORIGIN = "http://127.0.0.1:4781"
POLL_SECONDS = 1.0
FAIL_CLOSED_SECONDS = 25.0
BROWSER_REPORT_STALE_SECONDS = 15.0
CORRELATION_HEADER = "X-CannaBeats-Correlation-ID"
APPLICATION_VERSION = os.environ.get("CANNABEATS_APP_VERSION", "development")
CATALOG_VERSION = os.environ.get("CANNABEATS_CATALOG_VERSION", "development")
ENVIRONMENT = os.environ.get("CANNABEATS_ENVIRONMENT", "poc")

lock = threading.Lock()
state = {
    "lease": None,
    "command": None,
    "relayActive": None,
    "lastError": None,
    "lastSuccessfulPoll": 0.0,
    "browserReport": None,
}
device_id = None


def correlation_id(value=None):
    try:
        return str(uuid.UUID(str(value))) if value else str(uuid.uuid4())
    except (ValueError, TypeError, AttributeError):
        return str(uuid.uuid4())


def operational_log(level, event, message, **context):
    record = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "service": "managed-source-controller",
        "environment": ENVIRONMENT,
        "event": event,
        "message": message,
        "applicationVersion": APPLICATION_VERSION,
        "catalogVersion": CATALOG_VERSION,
    }
    for key in ("correlationId", "status", "reasonCode", "errorType"):
        if context.get(key) is not None:
            record[key] = context[key]
    print(json.dumps(record, separators=(",", ":")), flush=True)


def source_token():
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise RuntimeError("Managed source token is missing or invalid")
    return token


def record_browser_readiness(payload):
    if not isinstance(payload, dict):
        raise ValueError("Browser readiness payload is invalid")
    authorization = payload.get("spotifyAuthorization")
    player = payload.get("player")
    if authorization not in {"authorized", "not_authorized", "error", "unknown"}:
        raise ValueError("Spotify authorization state is invalid")
    if player not in {"ready", "not_ready", "error", "unknown"}:
        raise ValueError("Player readiness state is invalid")
    with lock:
        state["browserReport"] = {
            "spotifyAuthorization": authorization,
            "player": player,
            "reportedAt": time.monotonic(),
        }


def public_state():
    with lock:
        public = dict(state)
    last_poll = public.pop("lastSuccessfulPoll", 0.0)
    browser = public.pop("browserReport", None)
    if public.get("lastError") is not None:
        public["gameApi"] = {"status": "unavailable", "reasonCode": "game_api_unavailable"}
    elif last_poll > 0 and time.monotonic() - last_poll <= FAIL_CLOSED_SECONDS:
        public["gameApi"] = {"status": "healthy", "reasonCode": "authenticated_poll_succeeded"}
    elif last_poll > 0:
        public["gameApi"] = {"status": "unavailable", "reasonCode": "game_api_unavailable"}
    else:
        public["gameApi"] = {"status": "unknown", "reasonCode": "awaiting_first_poll"}

    if not browser:
        unknown_reason = "browser_not_reported"
    elif time.monotonic() - browser["reportedAt"] > BROWSER_REPORT_STALE_SECONDS:
        unknown_reason = "browser_report_stale"
    else:
        unknown_reason = None
    if unknown_reason:
        public["browserReadiness"] = {
            "spotifyAuthorization": {"status": "unknown", "reasonCode": unknown_reason},
            "player": {"status": "unknown", "reasonCode": unknown_reason},
        }
        return public

    authorization_states = {
        "authorized": {"status": "healthy", "reasonCode": "spotify_authorized"},
        "not_authorized": {"status": "degraded", "reasonCode": "spotify_not_authorized"},
        "error": {"status": "degraded", "reasonCode": "spotify_authorization_error"},
        "unknown": {"status": "unknown", "reasonCode": "browser_not_reported"},
    }
    player_states = {
        "ready": {"status": "healthy", "reasonCode": "player_ready"},
        "not_ready": {"status": "degraded", "reasonCode": "player_not_ready"},
        "error": {"status": "degraded", "reasonCode": "player_error"},
        "unknown": {"status": "unknown", "reasonCode": "browser_not_reported"},
    }
    public["browserReadiness"] = {
        "spotifyAuthorization": authorization_states[browser["spotifyAuthorization"]],
        "player": player_states[browser["player"]],
    }
    return public


def api_call(payload, requested_correlation_id=None):
    request_correlation_id = correlation_id(requested_correlation_id)
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {source_token()}",
            "Content-Type": "application/json",
            "User-Agent": "CannaBeatsManagedSource/0.2",
            CORRELATION_HEADER: request_correlation_id,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response_correlation_id = correlation_id(response.headers.get(CORRELATION_HEADER))
        return json.load(response), response_correlation_id


def set_relay(active, request_correlation_id=None):
    with lock:
        if state["relayActive"] == active:
            return
    action = "start" if active else "stop"
    subprocess.run(
        ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", action, "cannabeats-relay-push.service"],
        check=True,
        timeout=15,
    )
    with lock:
        state["relayActive"] = active
    operational_log(
        "info", "relay.state_changed", "Relay publisher state changed",
        correlationId=request_correlation_id,
        reasonCode="relay_started" if active else "relay_stopped",
    )


def poll_loop():
    global device_id
    while True:
        try:
            payload, request_correlation_id = api_call({"action": "poll", "deviceId": device_id})
            lease = payload.get("lease")
            command = payload.get("command")
            if command:
                command["correlationId"] = request_correlation_id
            set_relay(bool(lease), request_correlation_id)
            with lock:
                recovered = state["lastError"] is not None
                state.update({
                    "lease": lease,
                    "command": command,
                    "lastError": None,
                    "lastSuccessfulPoll": time.monotonic(),
                })
            if recovered:
                operational_log(
                    "info", "game_api.recovered", "Managed source polling recovered",
                    correlationId=request_correlation_id,
                )
        except Exception as error:
            with lock:
                first_failure = state["lastError"] is None
                state["lastError"] = "game_api_unavailable"
                stale = time.monotonic() - state["lastSuccessfulPoll"] > FAIL_CLOSED_SECONDS
            if first_failure:
                operational_log(
                    "warn", "game_api.poll_failed", "Managed source polling failed",
                    reasonCode="game_api_unavailable",
                    errorType=type(error).__name__,
                )
            if stale:
                try:
                    set_relay(False)
                except Exception:
                    pass
                with lock:
                    state["lease"] = None
                    state["command"] = None
        time.sleep(POLL_SECONDS)


class Handler(BaseHTTPRequestHandler):
    server_version = "CannaBeatsSourceController/0.2"

    def _origin_allowed(self):
        return self.headers.get("Origin") in (None, BROWSER_ORIGIN)

    def _send(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "send_correlation_id", None):
            self.send_header(CORRELATION_HEADER, self.send_correlation_id)
        if self.headers.get("Origin") == BROWSER_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", BROWSER_ORIGIN)
            self.send_header("Vary", "Origin")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_OPTIONS(self):
        if not self._origin_allowed():
            return self._send(403, {"error": "Origin not accepted"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", BROWSER_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if not self._origin_allowed():
            return self._send(403, {"error": "Origin not accepted"})
        if self.path == "/health":
            return self._send(200, {"ok": True})
        if self.path != "/state":
            return self._send(404, {"error": "Not found"})
        self._send(200, public_state())

    def do_POST(self):
        global device_id
        if not self._origin_allowed():
            return self._send(403, {"error": "Origin not accepted"})
        if self.path not in {"/complete", "/readiness"}:
            return self._send(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4096:
                raise ValueError("Request size is invalid")
            payload = json.loads(self.rfile.read(length))
            if self.path == "/readiness":
                record_browser_readiness(payload)
                return self._send(200, {"ok": True})
            command_id = str(payload.get("commandId", ""))
            with lock:
                expected = state["command"] and state["command"].get("id")
                command_correlation_id = state["command"] and state["command"].get("correlationId")
            if not expected or command_id != expected:
                return self._send(409, {"error": "Command is no longer pending"})
            reported_device = payload.get("deviceId")
            if isinstance(reported_device, str) and len(reported_device) <= 200:
                device_id = reported_device
            result, response_correlation_id = api_call({
                "action": "complete",
                "commandId": command_id,
                "ok": payload.get("ok") is True,
                "playbackStatus": payload.get("playbackStatus"),
                # Browser/player details stay on the source machine. The game API
                # receives only a stable operational category.
                "error": None if payload.get("ok") is True else "managed_playback_failed",
                "deviceId": device_id,
            }, command_correlation_id)
            with lock:
                state["command"] = None
            self.send_correlation_id = response_correlation_id
            self._send(200, result)
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "A valid JSON result is required"})
        except urllib.error.HTTPError as error:
            self._send(502, {"error": f"Game API rejected completion ({error.code})"})
        except Exception as error:
            operational_log(
                "warn", "command.completion_failed", "Managed command completion failed",
                correlationId=locals().get("command_correlation_id"),
                reasonCode="game_api_unavailable",
                errorType=type(error).__name__,
            )
            self._send(502, {"error": "Game API completion unavailable"})

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    source_token()
    threading.Thread(target=poll_loop, daemon=True).start()
    server = ThreadingHTTPServer(LISTEN_ADDRESS, Handler)
    def shutdown(signum, _frame):
        operational_log(
            "info", "service.stopping", "Managed source controller is stopping",
            reasonCode=signal.Signals(signum).name,
        )
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    operational_log("info", "service.started", "Managed source controller started")
    try:
        server.serve_forever()
    finally:
        server.server_close()
