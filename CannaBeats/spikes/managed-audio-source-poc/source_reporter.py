#!/usr/bin/env python3
"""Bounded source diagnostics reporter for the managed-audio controller."""

from __future__ import annotations

import json
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

PUBLISHER_INTERFACE = "btaudio-publisher-diagnostics/v1"
PUBLISHER_REQUEST_BYTES = 512
PUBLISHER_RESPONSE_BYTES = 2048
GAME_BODY_BYTES = 8192
PUBLISHER_TIMEOUT = 0.25
GAME_TIMEOUT = 2.0
WINDOW_TARGET_MS = 9000.0
WINDOW_MAX_MS = 10000.0
MAX_SAFE_INTEGER = 9_007_199_254_740_991
PUBLISHER_STATES = {
    "idle", "connecting", "publishing", "backoff", "stopped", "error", "unknown",
}
PLAYBACK_STATES = {"playing", "paused", "error", "unknown"}
RETRYABLE = {
    "collector_busy", "collector_degraded", "collector_unavailable",
    "diagnostic_unavailable", "request_timeout", "response_invalid", "unavailable",
}
CORRELATION_LOST = {
    "diagnostic_not_found", "stale_correlation", "trace_inactive", "source_session_lost",
}
FINITE_REPORT = {
    "accepted", "replayed", "quota_exhausted", "report_conflict", "report_invalid",
    *CORRELATION_LOST,
}
HTTP_FAILURES = {
    "authentication_required": 401, "not_authorized": 403,
    "request_invalid": 400, "request_timeout": 408,
    "diagnostic_not_found": 404, "request_conflict": 409, "trace_busy": 409,
    "read_expired": 409, "stale_correlation": 409, "trace_inactive": 409,
    "grant_lost": 409, "sharing_disabled": 409, "source_session_lost": 409,
    "relay_generation_unbound": 409, "report_conflict": 409,
    "report_invalid": 400, "rate_limited": 429, "collector_busy": 503,
    "collector_degraded": 503, "quota_exhausted": 503,
    "schema_incompatible": 503, "collector_response_invalid": 502,
    "state_response_invalid": 502, "collector_unavailable": 503,
    "diagnostic_unavailable": 503,
}


class SourceReporterError(RuntimeError):
    """Finite reporter failure; `code` is safe for operational output."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code if code in RETRYABLE | FINITE_REPORT else "unavailable"


def _uuid(value, *, version=None) -> str:
    if not isinstance(value, str) or value != value.lower():
        raise SourceReporterError("response_invalid")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError) as error:
        raise SourceReporterError("response_invalid") from error
    if parsed.version not in range(1, 9) or (version is not None and parsed.version != version) \
            or str(parsed) != value:
        raise SourceReporterError("response_invalid")
    return value


def _number(value, *, integer=False, minimum=0, maximum=MAX_SAFE_INTEGER):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SourceReporterError("response_invalid")
    if integer and not isinstance(value, int):
        raise SourceReporterError("response_invalid")
    if not minimum <= value <= maximum:
        raise SourceReporterError("response_invalid")
    return value


def _exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise SourceReporterError("response_invalid")
    return value


def validate_publisher_snapshot(value):
    keys = {
        "interface", "schemaVersion", "instanceId", "sampleRate", "channels",
        "encoding", "capturedFrames", "enqueuedFrames", "publishedFrames",
        "publishedBytes", "captureGapCount", "droppedUploadCount", "reconnectCount",
        "publisherRestartCount", "publisherState",
    }
    value = _exact(value, keys)
    if value["interface"] != PUBLISHER_INTERFACE or value["schemaVersion"] != 1:
        raise SourceReporterError("response_invalid")
    result = dict(value)
    result["instanceId"] = _uuid(value["instanceId"], version=4)
    result["sampleRate"] = _number(value["sampleRate"], integer=True, minimum=8000, maximum=384000)
    if value["channels"] not in (1, 2) or value["encoding"] != "s16le":
        raise SourceReporterError("response_invalid")
    for field in (
        "capturedFrames", "enqueuedFrames", "publishedFrames", "publishedBytes",
        "captureGapCount", "droppedUploadCount", "reconnectCount",
        "publisherRestartCount",
    ):
        result[field] = _number(value[field], integer=True)
    if value["publisherState"] not in PUBLISHER_STATES:
        raise SourceReporterError("response_invalid")
    if not result["publishedFrames"] <= result["enqueuedFrames"] <= result["capturedFrames"]:
        raise SourceReporterError("response_invalid")
    if result["publishedBytes"] != result["publishedFrames"] * result["channels"] * 2:
        raise SourceReporterError("response_invalid")
    return result


class PublisherSnapshotClient:
    def __init__(self, path: Path, timeout=PUBLISHER_TIMEOUT):
        self.path = Path(path)
        self.timeout = timeout

    def snapshot(self):
        request = json.dumps({
            "interface": PUBLISHER_INTERFACE, "action": "snapshot",
        }, separators=(",", ":")).encode() + b"\n"
        if len(request) > PUBLISHER_REQUEST_BYTES:
            raise SourceReporterError("unavailable")
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        deadline = time.monotonic() + self.timeout
        try:
            connection.connect(str(self.path))
            connection.sendall(request)
            data = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SourceReporterError("unavailable")
                connection.settimeout(remaining)
                chunk = connection.recv(PUBLISHER_RESPONSE_BYTES + 1 - len(data))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > PUBLISHER_RESPONSE_BYTES:
                    raise SourceReporterError("response_invalid")
        except SourceReporterError:
            raise
        except (OSError, TimeoutError) as error:
            raise SourceReporterError("unavailable") from error
        finally:
            connection.close()
        try:
            if data.count(b"\n") != 1 or not data.endswith(b"\n"):
                raise SourceReporterError("response_invalid")
            response = json.loads(bytes(data[:-1]).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SourceReporterError("response_invalid") from error
        response = _exact(response, {"status", "snapshot"})
        if response["status"] != "ok":
            raise SourceReporterError("unavailable")
        return validate_publisher_snapshot(response["snapshot"])


class SourceGameClient:
    def __init__(self, url: str, token_reader, *, timeout=GAME_TIMEOUT, opener=None):
        self.url = url
        self.token_reader = token_reader
        self.timeout = timeout
        self.opener = opener or urllib.request.urlopen
        self._inflight = None

    @staticmethod
    def _http_failure(error):
        try:
            raw = error.read(GAME_BODY_BYTES + 1)
            if len(raw) > GAME_BODY_BYTES:
                raise SourceReporterError("response_invalid")
            parsed = json.loads(raw.decode("utf-8"))
            parsed = _exact(parsed, {"error", "code"})
            code = parsed["code"]
            expected_message = (
                "Diagnostic trace not found." if code == "diagnostic_not_found"
                else "Sign in required." if code == "authentication_required"
                else "Diagnostics are temporarily unavailable."
            )
            if HTTP_FAILURES.get(code) != error.code or parsed["error"] != expected_message:
                raise SourceReporterError("response_invalid")
            return SourceReporterError(code)
        except SourceReporterError as failure:
            return failure
        except Exception:
            return SourceReporterError("response_invalid")

    def _perform_request(self, body, result, timing_clock):
        try:
            request = urllib.request.Request(self.url, data=body, headers={
                "Authorization": f"Bearer {self.token_reader()}",
                "Content-Type": "application/json",
                "User-Agent": "CannaBeatsSourceReporter/1",
            }, method="POST")
            with self.opener(request, timeout=self.timeout) as response:
                raw = response.read(GAME_BODY_BYTES + 1)
                if len(raw) > GAME_BODY_BYTES:
                    raise SourceReporterError("response_invalid")
                value = json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as error:
            result["error"] = self._http_failure(error)
        except SourceReporterError as error:
            result["error"] = error
        except Exception:
            result["error"] = SourceReporterError("unavailable")
        else:
            result["value"] = value
        finally:
            if timing_clock is not None:
                try:
                    result["timing"]["localReceiveMs"] = timing_clock()
                except Exception:
                    result["error"] = SourceReporterError("unavailable")
            result["done"].set()

    def _request(self, value, timing_clock=None):
        try:
            fingerprint = json.dumps(value, separators=(",", ":")).encode("utf-8")
        except Exception as error:
            raise SourceReporterError("response_invalid") from error
        if len(fingerprint) > GAME_BODY_BYTES:
            raise SourceReporterError("response_invalid")
        if self._inflight is not None and self._inflight["fingerprint"] != fingerprint:
            raise SourceReporterError("unavailable")
        if self._inflight is None:
            result = {"done": threading.Event()}
            if timing_clock is not None:
                try:
                    result["timing"] = {"localSendMs": timing_clock()}
                except Exception as error:
                    raise SourceReporterError("unavailable") from error
            self._inflight = {"fingerprint": fingerprint, "result": result}
            threading.Thread(
                target=self._perform_request,
                args=(fingerprint, result, timing_clock), daemon=True,
            ).start()
        elif ("timing" in self._inflight["result"]) != (timing_clock is not None):
            raise SourceReporterError("unavailable")
        result = self._inflight["result"]
        if not result["done"].wait(self.timeout):
            raise SourceReporterError("request_timeout")
        self._inflight = None
        if "error" in result:
            raise result["error"]
        response = result.get("value")
        if not isinstance(response, dict):
            raise SourceReporterError("response_invalid")
        return (response, result.get("timing")) if timing_clock is not None else response

    def open(self, request_id, instance_id):
        value = _exact(self._request({
            "action": "open", "requestId": request_id, "sourceInstanceId": instance_id,
        }), {"status", "sourceGrantId", "traceId", "sourceInstanceId", "expiresAtMs"})
        if value["status"] not in {"opened", "replayed"} or value["sourceInstanceId"] != instance_id:
            raise SourceReporterError("response_invalid")
        _uuid(value["sourceGrantId"])
        _uuid(value["traceId"])
        _number(value["expiresAtMs"], integer=True)
        return value

    def synchronize(self, request_id, grant_id, instance_id, monotonic_ms):
        value, timing = self._request({
            "action": "synchronize", "requestId": request_id, "sourceGrantId": grant_id,
        }, timing_clock=monotonic_ms)
        local_send = timing["localSendMs"]
        local_receive = timing["localReceiveMs"]
        value = _exact(value, {
            "status", "sourceGrantId", "sampleId", "timebaseId", "instanceId",
            "serverReceiveMs", "serverSendMs",
        })
        if value["status"] not in {"accepted", "replayed"} \
                or value["sourceGrantId"] != grant_id or value["instanceId"] != instance_id:
            raise SourceReporterError("response_invalid")
        _uuid(value["sampleId"])
        _uuid(value["timebaseId"])
        server_receive = _number(value["serverReceiveMs"], integer=True)
        server_send = _number(value["serverSendMs"], integer=True)
        if local_receive < local_send or local_receive - local_send > 2000 \
                or server_send < server_receive or server_send - server_receive > local_receive - local_send:
            raise SourceReporterError("response_invalid")
        return value, {
            "sampleId": value["sampleId"], "instanceId": instance_id,
            "localSendMs": local_send, "localReceiveMs": local_receive,
        }

    def report(self, grant_id, core, observation):
        value = self._request({
            "sourceGrantId": grant_id,
            "measurementCore": core,
            "sampleObservation": observation,
        })
        status = value.get("status")
        if status in {"accepted", "replayed"}:
            _exact(value, {"status", "receivedAt"})
            _number(value["receivedAt"], integer=True)
        elif status in FINITE_REPORT - {"accepted", "replayed"}:
            _exact(value, {"status"})
        else:
            raise SourceReporterError("response_invalid")
        return value


def _request_id(label: str) -> str:
    return str(uuid.uuid5(uuid.UUID(int=0), label))


class SourceReporter:
    """One-owner reporter state machine; `tick` performs at most one network action."""

    def __init__(self, publisher, game, playback_snapshot, *, monotonic_ms=None,
                 monotonic_ns=None, logger=None):
        self.publisher = publisher
        self.game = game
        self.playback_snapshot = playback_snapshot
        self.monotonic_ms = monotonic_ms or (lambda: time.monotonic_ns() / 1_000_000)
        self.monotonic_ns = monotonic_ns or time.monotonic_ns
        self.logger = logger or (lambda _code: None)
        self.instance_id = None
        self.grant = None
        self.sample = None
        self.observation = None
        self.pending_sync = None
        self.window_sequence = None
        self.window_start_ms = None
        self.previous_snapshot = None
        self.previous_playback = "unknown"
        self.pending_window = None
        self.pending_transition = None
        self.last_sequence = -1
        self.last_transition_send_ms = -float("inf")
        self.backoff_seconds = 1
        self.retry_needed = False
        self.deferred_transition = None
        self.open_generation = 0
        self.pending_open_request_id = None

    def _sequence(self):
        # Four identities per monotonic microsecond leave room for the bounded
        # window+transition pair while preserving restart monotonicity without
        # a reporter journal for practical boot lifetimes.
        candidate = (self.monotonic_ns() // 1000) * 4
        self.last_sequence = max(self.last_sequence + 1, candidate)
        if self.last_sequence > MAX_SAFE_INTEGER:
            raise SourceReporterError("unavailable")
        return self.last_sequence

    def _clear_correlation(self, *, advance_open=False):
        self.grant = None
        self.sample = None
        self.observation = None
        self.pending_sync = None
        self.window_sequence = None
        self.window_start_ms = None
        self.pending_window = None
        self.pending_transition = None
        self.deferred_transition = None
        self.pending_open_request_id = None
        if advance_open:
            self.open_generation += 1

    def _open(self, snapshot, restarted=False):
        instance_id = snapshot["instanceId"]
        if self.instance_id is not None and instance_id != self.instance_id:
            self.open_generation = 0
            self.pending_open_request_id = None
        if self.pending_open_request_id is None:
            self.pending_open_request_id = _request_id(
                f"source-open:{instance_id}:{self.open_generation}"
            )
        self.grant = self.game.open(
            self.pending_open_request_id, instance_id,
        )
        self.pending_open_request_id = None
        self.instance_id = instance_id
        self.previous_snapshot = snapshot
        self.previous_playback = self._playback()
        if restarted:
            self.deferred_transition = ("publisher_restarted", {
                "category": "observed", "reason": "process_restart",
            })

    def _playback(self):
        value = self.playback_snapshot()
        return value if value in PLAYBACK_STATES else "unknown"

    def _synchronize(self):
        if self.pending_sync is None:
            sequence = self._sequence()
            self.pending_sync = {
                "sequence": sequence,
                "requestId": _request_id(f"source-sync:{self.instance_id}:{sequence}"),
            }
        sequence = self.pending_sync["sequence"]
        sample, observation = self.game.synchronize(
            self.pending_sync["requestId"],
            self.grant["sourceGrantId"], self.instance_id, self.monotonic_ms,
        )
        if sample.get("timebaseId") != self.grant["traceId"]:
            raise SourceReporterError("response_invalid")
        self.sample = sample
        self.observation = observation
        self.window_sequence = sequence
        self.window_start_ms = observation["localReceiveMs"]
        self.pending_sync = None
        self.backoff_seconds = 1

    def _queue_transition(self, kind, fields, *, sequence=None, start_ms=None):
        if self.sample is None or self.observation is None:
            return
        priority = {
            "publisher_restarted": 4, "publisher_started": 2, "playback_changed": 1,
        }[kind]
        if self.pending_transition and self.pending_transition["priority"] >= priority:
            return
        sequence = self._sequence() if sequence is None else sequence
        core = {
            "schemaVersion": 1, "kind": "source_transition",
            "instanceId": self.instance_id, "sequence": sequence,
            "monotonicStartMs": max(
                self.monotonic_ms() if start_ms is None else start_ms,
                self.observation["localReceiveMs"],
            ),
            "durationMs": 0,
            "measurements": {"type": kind, **fields},
        }
        self.pending_transition = {
            "priority": priority, "core": core,
            "observation": dict(self.observation), "attempted": False,
        }

    def _window_core(self, snapshot, playback, duration):
        return {
            "schemaVersion": 1, "kind": "source_window", "instanceId": self.instance_id,
            "sequence": self.window_sequence, "monotonicStartMs": self.window_start_ms,
            "durationMs": duration,
            "measurements": {
                "sampleRate": snapshot["sampleRate"], "channels": snapshot["channels"],
                "encoding": snapshot["encoding"], "capturedFrames": snapshot["capturedFrames"],
                "enqueuedFrames": snapshot["enqueuedFrames"],
                "publishedFrames": snapshot["publishedFrames"],
                "publishedBytes": snapshot["publishedBytes"],
                "captureGapCount": snapshot["captureGapCount"],
                "droppedUploadCount": snapshot["droppedUploadCount"],
                "reconnectCount": snapshot["reconnectCount"],
                "publisherRestartCount": snapshot["publisherRestartCount"],
                "publisherState": snapshot["publisherState"],
                "playbackObservation": playback,
            },
        }

    def _observe_transition(self, snapshot, playback):
        prior = self.previous_snapshot
        if prior and snapshot["publisherRestartCount"] > prior["publisherRestartCount"]:
            self._queue_transition("publisher_restarted", {
                "category": "error", "reason": "publisher_unavailable",
            })
        elif prior and prior["publisherState"] != "publishing" \
                and snapshot["publisherState"] == "publishing":
            self._queue_transition("publisher_started", {"category": "observed"})
        elif playback != self.previous_playback:
            category = "error" if playback == "error" else "unknown" if playback == "unknown" else "observed"
            self._queue_transition("playback_changed", {
                "category": category, "playbackObservation": playback,
            })

    def _validate_progress(self, snapshot):
        prior = self.previous_snapshot
        if prior is None:
            return
        if any(snapshot[field] != prior[field] for field in (
            "sampleRate", "channels", "encoding",
        )) or any(snapshot[field] < prior[field] for field in (
            "capturedFrames", "enqueuedFrames", "publishedFrames", "publishedBytes",
            "captureGapCount", "droppedUploadCount", "reconnectCount",
            "publisherRestartCount",
        )):
            raise SourceReporterError("response_invalid")

    def _next_pending(self):
        values = [value for value in (self.pending_window, self.pending_transition) if value]
        return min(values, key=lambda value: value["core"]["sequence"]) if values else None

    def _retire(self, pending):
        if pending is self.pending_window:
            self.pending_window = None
        if pending is self.pending_transition:
            self.pending_transition = None

    def _send_pending(self, pending):
        now = self.monotonic_ms()
        if pending is self.pending_transition and now - self.last_transition_send_ms < 1000:
            return
        pending["attempted"] = True
        try:
            result = self.game.report(
                self.grant["sourceGrantId"], pending["core"], pending["observation"],
            )
            code = result["status"]
        except SourceReporterError as error:
            code = error.code
            if code in RETRYABLE:
                self.retry_needed = True
                self.logger(code)
                return
        if pending is self.pending_transition:
            self.last_transition_send_ms = now
        if code in {
            "accepted", "replayed", "quota_exhausted", "report_conflict", "report_invalid",
        }:
            self._retire(pending)
        elif code in CORRELATION_LOST:
            self._clear_correlation(advance_open=True)
        else:
            self.logger("response_invalid")
            return
        self.backoff_seconds = 1

    def tick(self):
        self.retry_needed = False
        pending = self._next_pending()
        if pending is not None:
            self._send_pending(pending)
            return
        try:
            snapshot = self.publisher.snapshot()
            if self.instance_id is None:
                self._open(snapshot)
            elif snapshot["instanceId"] != self.instance_id:
                self._clear_correlation()
                self._open(snapshot, restarted=True)
            elif self.grant is None:
                self._open(snapshot)
            self._validate_progress(snapshot)
            if self.sample is None:
                self._synchronize()
                if self.deferred_transition is not None:
                    kind, fields = self.deferred_transition
                    self.deferred_transition = None
                    transition_sequence = self.window_sequence
                    self.window_sequence = self._sequence()
                    self._queue_transition(
                        kind, fields, sequence=transition_sequence,
                        start_ms=self.observation["localReceiveMs"],
                    )
                return
            elapsed = self.monotonic_ms() - self.window_start_ms
            if elapsed < WINDOW_TARGET_MS:
                return
            if elapsed <= 0 or elapsed > WINDOW_MAX_MS:
                self.sample = self.observation = None
                self.window_sequence = self.window_start_ms = None
                self.logger("coverage_gap")
                return
            closing = snapshot
            playback = self._playback()
            self.pending_window = {
                "priority": 0, "core": self._window_core(closing, playback, elapsed),
                "observation": dict(self.observation), "attempted": False,
            }
            self._observe_transition(closing, playback)
            self.previous_snapshot = closing
            self.previous_playback = playback
            self.sample = self.observation = None
            self.window_sequence = self.window_start_ms = None
            self._send_pending(self._next_pending())
        except SourceReporterError as error:
            self.retry_needed = True
            self.logger(error.code)
            if error.code in CORRELATION_LOST:
                self._clear_correlation(advance_open=True)

    def run(self, stop_event: threading.Event):
        while not stop_event.is_set():
            before = self.monotonic_ms()
            try:
                self.tick()
            except Exception:
                # Diagnostics must neither print a native traceback nor terminate
                # the reporter when an unexpected local dependency fails.
                self.retry_needed = True
                self.logger("unavailable")
            if self.retry_needed:
                delay = self.backoff_seconds
                self.backoff_seconds = min(30, self.backoff_seconds * 2)
            elif self._next_pending() is not None:
                delay = 0.05
            elif self.sample is not None and self.window_start_ms is not None:
                remaining = (WINDOW_TARGET_MS - (
                    self.monotonic_ms() - self.window_start_ms
                )) / 1000
                delay = max(0.05, remaining)
            else:
                delay = 0.05
            spent = max(0, (self.monotonic_ms() - before) / 1000)
            stop_event.wait(max(0.05, delay - spent))
