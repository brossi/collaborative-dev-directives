#!/usr/bin/env python3
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
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

lock = threading.Lock()
state = {
    "lease": None,
    "command": None,
    "relayActive": None,
    "lastError": None,
    "lastSuccessfulPoll": 0.0,
}
device_id = None


def source_token():
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise RuntimeError("Managed source token is missing or invalid")
    return token


def api_call(payload):
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {source_token()}",
            "Content-Type": "application/json",
            "User-Agent": "CannaBeatsManagedSource/0.2",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def set_relay(active):
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


def poll_loop():
    global device_id
    while True:
        try:
            payload = api_call({"action": "poll", "deviceId": device_id})
            lease = payload.get("lease")
            command = payload.get("command")
            set_relay(bool(lease))
            with lock:
                state.update({
                    "lease": lease,
                    "command": command,
                    "lastError": None,
                    "lastSuccessfulPoll": time.monotonic(),
                })
        except Exception as error:
            with lock:
                state["lastError"] = str(error)[:500]
                stale = time.monotonic() - state["lastSuccessfulPoll"] > FAIL_CLOSED_SECONDS
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
        with lock:
            public = dict(state)
        public.pop("lastSuccessfulPoll", None)
        self._send(200, public)

    def do_POST(self):
        global device_id
        if not self._origin_allowed():
            return self._send(403, {"error": "Origin not accepted"})
        if self.path != "/complete":
            return self._send(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4096:
                raise ValueError("Request size is invalid")
            payload = json.loads(self.rfile.read(length))
            command_id = str(payload.get("commandId", ""))
            with lock:
                expected = state["command"] and state["command"].get("id")
            if not expected or command_id != expected:
                return self._send(409, {"error": "Command is no longer pending"})
            reported_device = payload.get("deviceId")
            if isinstance(reported_device, str) and len(reported_device) <= 200:
                device_id = reported_device
            result = api_call({
                "action": "complete",
                "commandId": command_id,
                "ok": payload.get("ok") is True,
                "playbackStatus": payload.get("playbackStatus"),
                "error": str(payload.get("error", ""))[:500] or None,
                "deviceId": device_id,
            })
            with lock:
                state["command"] = None
            self._send(200, result)
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "A valid JSON result is required"})
        except urllib.error.HTTPError as error:
            self._send(502, {"error": f"Game API rejected completion ({error.code})"})
        except Exception as error:
            self._send(502, {"error": str(error)[:500]})

    def log_message(self, format, *args):
        print(f"{self.client_address[0]} {self.command} {self.path}", flush=True)


if __name__ == "__main__":
    source_token()
    threading.Thread(target=poll_loop, daemon=True).start()
    server = ThreadingHTTPServer(LISTEN_ADDRESS, Handler)
    print(f"Managed source controller listening on http://{LISTEN_ADDRESS[0]}:{LISTEN_ADDRESS[1]}", flush=True)
    server.serve_forever()
