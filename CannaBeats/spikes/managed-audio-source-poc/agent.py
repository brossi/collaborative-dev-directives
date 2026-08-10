#!/usr/bin/env python3
import json
import mimetypes
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

APP_ORIGIN = os.environ.get("CANNABEATS_APP_ORIGIN", "https://poc.cannabeats.social").rstrip("/")
STATIC_DIRECTORY = Path(__file__).resolve().parent / "source-ui"
LISTEN_ADDRESS = ("127.0.0.1", 4781)


class Handler(BaseHTTPRequestHandler):
    server_version = "CannaBeatsManagedSource/0.1"

    def _headers(self, status, content_type, length):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "; ".join((
                "default-src 'self'",
                "base-uri 'none'",
                "frame-ancestors 'none'",
                "frame-src https://sdk.scdn.co",
                "script-src 'self' https://sdk.scdn.co",
                "style-src 'self'",
                "connect-src 'self' http://127.0.0.1:4782 https://accounts.spotify.com https://api.spotify.com wss://dealer.spotify.com",
                "media-src 'self' blob: https://*.scdn.co",
                "worker-src 'self' blob:",
            )),
        )
        self.end_headers()

    def _send(self, status, content_type, body):
        payload = body if isinstance(body, bytes) else body.encode("utf-8")
        self._headers(status, content_type, len(payload))
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            return self._send(200, "application/json", '{"ok":true}')
        if path == "/config":
            try:
                with urllib.request.urlopen(f"{APP_ORIGIN}/api/config", timeout=5) as response:
                    public = json.load(response)
                body = json.dumps({
                    "spotifyClientId": public["spotifyClientId"],
                    "spotifyRedirectUri": f"{APP_ORIGIN}/spotify/callback",
                })
                return self._send(200, "application/json", body)
            except Exception:
                return self._send(503, "application/json", '{"error":"CannaBeats configuration unavailable"}')
        if path in ("/", "/callback"):
            file_path = STATIC_DIRECTORY / "index.html"
        elif path == "/app.js":
            file_path = STATIC_DIRECTORY / "app.js"
        elif path == "/styles.css":
            file_path = STATIC_DIRECTORY / "styles.css"
        else:
            return self._send(404, "text/plain; charset=utf-8", "Not found")
        try:
            body = file_path.read_bytes()
        except OSError:
            return self._send(500, "text/plain; charset=utf-8", "Source UI unavailable")
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self._send(200, f"{content_type}; charset=utf-8", body)

    def log_message(self, format, *args):
        # OAuth callbacks contain a one-time authorization code. Never include
        # query strings in service logs.
        path = urlsplit(self.path).path
        print(f'{self.client_address[0]} {self.command} {path}', flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer(LISTEN_ADDRESS, Handler)
    print(f"Managed source UI listening on http://{LISTEN_ADDRESS[0]}:{LISTEN_ADDRESS[1]}", flush=True)
    server.serve_forever()
