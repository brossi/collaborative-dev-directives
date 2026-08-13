#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import tempfile
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
PENDING_COMPLETION_PATH = Path(os.environ.get(
    "CANNABEATS_PENDING_COMPLETION_FILE",
    "/var/lib/cannabeats-controller/pending-completion.json",
))

lock = threading.Lock()
state = {
    "lease": None,
    "command": None,
    "pendingCompletion": None,
    "commandOutbox": None,
    "recoveryGeneration": None,
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


def transition_request_id(action, command_id, claim_generation):
    return str(uuid.uuid5(
        uuid.UUID(int=0), f"{action}:{command_id}:{claim_generation}",
    ))


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
    outbox = public.pop("commandOutbox", None)
    if public.pop("pendingCompletion", None) is not None:
        # Spotify has already executed this command. Keep it out of the browser
        # work queue while only its game-API acknowledgement is being retried.
        public["command"] = None
    if outbox is not None:
        if outbox.get("phase") == "claimed":
            public["command"] = {
                **outbox["command"],
                "claimGeneration": outbox["generation"],
            }
        else:
            public["command"] = None
        if outbox.get("phase") in {"executing", "outcome_unknown"}:
            public["commandRecovery"] = {
                "status": "outcome_unknown",
                "reasonCode": "execution_started_without_durable_outcome",
            }
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


def _completion_payload(payload):
    command_id = str(payload.get("commandId", ""))
    playback_status = payload.get("playbackStatus")
    if not command_id or playback_status not in {"ready", "playing", "paused", "error"} \
            or type(payload.get("ok")) is not bool:
        raise ValueError("Managed command completion is invalid")
    ok = payload["ok"]
    if (not ok and playback_status != "error") or (ok and playback_status == "error"):
        raise ValueError("Managed command completion state is invalid")
    completion = {
        "action": "complete",
        "commandId": command_id,
        "ok": ok,
        "playbackStatus": playback_status,
        "error": None if ok else "managed_playback_failed",
    }
    if payload.get("claimGeneration") is not None:
        completion["claimGeneration"] = str(uuid.UUID(str(payload["claimGeneration"])))
        completion["requestId"] = transition_request_id(
            "complete", command_id, completion["claimGeneration"],
        )
    if payload.get("protocolVersion") == 1:
        completion["protocolVersion"] = 1
    return completion


def persist_pending_completion(pending):
    PENDING_COMPLETION_PATH.parent.mkdir(parents=True, exist_ok=True)
    if pending is None:
        try:
            PENDING_COMPLETION_PATH.unlink()
        except FileNotFoundError:
            pass
        directory = os.open(PENDING_COMPLETION_PATH.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{PENDING_COMPLETION_PATH.name}.",
        dir=PENDING_COMPLETION_PATH.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(pending, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, PENDING_COMPLETION_PATH)
        directory = os.open(PENDING_COMPLETION_PATH.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def load_pending_completion():
    try:
        pending = json.loads(PENDING_COMPLETION_PATH.read_text(encoding="utf-8"))
        completion = _completion_payload(pending.get("payload", {}))
        correlation = pending.get("correlationId")
        if correlation is not None:
            correlation = str(uuid.UUID(str(correlation)))
        loaded = {"payload": completion, "correlationId": correlation}
    except FileNotFoundError:
        loaded = None
    except (ValueError, TypeError, AttributeError, json.JSONDecodeError) as error:
        raise RuntimeError("Persisted managed completion is invalid") from error
    with lock:
        state["pendingCompletion"] = loaded
    return loaded


def persist_command_outbox(outbox):
    persist_pending_completion(outbox)


def _validated_outbox(value):
    if not isinstance(value, dict):
        raise ValueError("Persisted managed command outbox is invalid")
    generation = str(uuid.UUID(str(value.get("generation"))))
    command_id = str(uuid.UUID(str(value.get("commandId"))))
    phase = value.get("phase")
    if phase not in {"claim_pending", "claimed", "executing", "outcome_unknown", "outcome_pending"}:
        raise ValueError("Persisted managed command phase is invalid")
    result = dict(value)
    result.update({"generation": generation, "commandId": command_id, "phase": phase})
    if phase in {"claim_pending", "claimed", "executing", "outcome_unknown"}:
        command = result.get("command")
        if not isinstance(command, dict) or command.get("id") != command_id:
            raise ValueError("Persisted managed command is invalid")
    if phase == "outcome_pending":
        completion = _completion_payload(result.get("payload", {}))
        if completion.get("claimGeneration") != generation:
            raise ValueError("Persisted managed command outcome generation is invalid")
        result["payload"] = completion
    correlation = result.get("correlationId")
    if correlation is not None:
        result["correlationId"] = str(uuid.UUID(str(correlation)))
    return result


def load_command_outbox():
    try:
        loaded = _validated_outbox(json.loads(PENDING_COMPLETION_PATH.read_text(encoding="utf-8")))
    except FileNotFoundError:
        loaded = None
    except (ValueError, TypeError, AttributeError, json.JSONDecodeError) as error:
        raise RuntimeError("Persisted managed command outbox is invalid") from error
    with lock:
        state["commandOutbox"] = loaded
        state["recoveryGeneration"] = (
            loaded.get("generation") if loaded and loaded.get("phase") == "executing" else None
        )
    return loaded


def load_durable_command_state():
    try:
        value = json.loads(PENDING_COMPLETION_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        with lock:
            state["commandOutbox"] = None
            state["pendingCompletion"] = None
        return None
    if isinstance(value, dict) and "phase" in value:
        return load_command_outbox()
    # Upgrade input from the completion-only outbox used before ADR 0002.
    return load_pending_completion()


def claim_polled_command(command, request_correlation_id=None, api=api_call, protocol_version=2):
    command_id = str(uuid.UUID(str(command.get("id"))))
    with lock:
        current = state.get("commandOutbox")
        if current:
            if current["commandId"] != command_id:
                raise ValueError("A different managed command is unresolved")
            outbox = dict(current)
        else:
            outbox = {
                "generation": str(uuid.uuid4()),
                "commandId": command_id,
                "phase": "claim_pending",
                "command": dict(command),
                "correlationId": request_correlation_id,
                "protocolVersion": protocol_version,
            }
            persist_command_outbox(outbox)
            state["commandOutbox"] = outbox
    if outbox.get("protocolVersion") == 1:
        result = {"accepted": True, "status": "claimed", "replayed": False}
        response_correlation_id = outbox.get("correlationId")
    else:
        result, response_correlation_id = api({
            "action": "claim",
            "commandId": command_id,
            "claimGeneration": outbox["generation"],
            "requestId": transition_request_id("claim", command_id, outbox["generation"]),
        }, outbox.get("correlationId"))
    if not isinstance(result, dict) or result.get("accepted") is not True \
            or result.get("status") != "claimed" or not isinstance(result.get("replayed"), bool):
        raise ValueError("Managed command claim acknowledgement is invalid")
    with lock:
        current = state.get("commandOutbox")
        if current and current["generation"] == outbox["generation"]:
            current = {**current, "phase": "claimed", "correlationId": response_correlation_id}
            state["commandOutbox"] = current
            persist_command_outbox(current)
    return {"accepted": True, "claimGeneration": outbox["generation"]}


def accept_browser_begin(payload, api=api_call):
    command_id = str(uuid.UUID(str(payload.get("commandId"))))
    generation = str(uuid.UUID(str(payload.get("claimGeneration"))))
    with lock:
        current = state.get("commandOutbox")
        if not current or current["commandId"] != command_id \
                or current["generation"] != generation or current["phase"] != "claimed":
            raise ValueError("Managed command claim is no longer executable")
        executing = {**current, "phase": "executing"}
        persist_command_outbox(executing)
        state["commandOutbox"] = executing
        state["recoveryGeneration"] = None
    if executing.get("protocolVersion") == 1:
        result = {"accepted": True, "status": "executing", "replayed": False}
        response_correlation_id = executing.get("correlationId")
    else:
        result, response_correlation_id = api({
            "action": "begin", "commandId": command_id, "claimGeneration": generation,
            "requestId": transition_request_id("begin", command_id, generation),
        }, executing.get("correlationId"))
    if not isinstance(result, dict) or result.get("accepted") is not True \
            or result.get("status") != "executing" or not isinstance(result.get("replayed"), bool):
        raise ValueError("Managed command execution acknowledgement is invalid")
    return {"accepted": True, "claimGeneration": generation,
            "correlationId": response_correlation_id}


def retry_unresolved_execution(api=api_call):
    with lock:
        outbox = state.get("commandOutbox")
        recovery_generation = state.get("recoveryGeneration")
    if not outbox or outbox.get("phase") != "executing" \
            or recovery_generation != outbox.get("generation"):
        return False
    result, response_correlation_id = api({
        "action": "outcome_unknown",
        "commandId": outbox["commandId"],
        "claimGeneration": outbox["generation"],
        "requestId": transition_request_id(
            "outcome_unknown", outbox["commandId"], outbox["generation"],
        ),
    }, outbox.get("correlationId"))
    if not isinstance(result, dict) or result.get("accepted") is not True \
            or result.get("status") != "outcome_unknown" \
            or not isinstance(result.get("replayed"), bool):
        raise ValueError("Managed unknown-outcome acknowledgement is invalid")
    with lock:
        current = state.get("commandOutbox")
        if current and current.get("generation") == outbox["generation"] \
                and current.get("commandId") == outbox["commandId"] \
                and current.get("phase") == "executing":
            reconciled = {
                **current,
                "phase": "outcome_unknown",
                "correlationId": response_correlation_id,
            }
            persist_command_outbox(reconciled)
            state["commandOutbox"] = reconciled
            state["recoveryGeneration"] = None
    return True


def accept_browser_unknown(payload, api=api_call):
    command_id = str(uuid.UUID(str(payload.get("commandId"))))
    generation = str(uuid.UUID(str(payload.get("claimGeneration"))))
    with lock:
        current = state.get("commandOutbox")
        if not current or current.get("commandId") != command_id \
                or current.get("generation") != generation \
                or current.get("phase") not in {"executing", "outcome_unknown"}:
            raise ValueError("Managed command execution is not awaiting reconciliation")
    if current.get("phase") == "executing":
        if current.get("protocolVersion") == 1:
            with lock:
                latest = state.get("commandOutbox")
                if latest and latest.get("generation") == generation \
                        and latest.get("phase") == "executing":
                    reconciled = {**latest, "phase": "outcome_unknown"}
                    persist_command_outbox(reconciled)
                    state["commandOutbox"] = reconciled
        else:
            result, response_correlation_id = api({
                "action": "outcome_unknown",
                "commandId": command_id,
                "claimGeneration": generation,
                "requestId": transition_request_id("outcome_unknown", command_id, generation),
            }, current.get("correlationId"))
            if not isinstance(result, dict) or result.get("accepted") is not True \
                    or result.get("status") != "outcome_unknown" \
                    or not isinstance(result.get("replayed"), bool):
                raise ValueError("Managed unknown-outcome acknowledgement is invalid")
            with lock:
                latest = state.get("commandOutbox")
                if latest and latest.get("generation") == generation \
                        and latest.get("commandId") == command_id \
                        and latest.get("phase") == "executing":
                    reconciled = {
                        **latest,
                        "phase": "outcome_unknown",
                        "correlationId": response_correlation_id,
                    }
                    persist_command_outbox(reconciled)
                    state["commandOutbox"] = reconciled
    return {"accepted": True, "status": "outcome_unknown"}


def retry_pending_completion(api=api_call):
    with lock:
        outbox = state.get("commandOutbox")
        pending = state.get("pendingCompletion")
    if outbox and outbox.get("phase") == "outcome_pending":
        result, response_correlation_id = api(
            outbox["payload"], outbox.get("correlationId"),
        )
        v1_ack = outbox.get("protocolVersion") == 1 \
            and isinstance(result, dict) and result.get("completed") is True \
            and ("replayed" not in result or isinstance(result.get("replayed"), bool))
        if not v1_ack and (not isinstance(result, dict) or result.get("completed") is not True \
                or not isinstance(result.get("replayed"), bool)):
            raise ValueError("Managed completion acknowledgement is invalid")
        with lock:
            current = state.get("commandOutbox")
            if current and current.get("generation") == outbox["generation"] \
                    and current.get("commandId") == outbox["commandId"] \
                    and current.get("phase") == "outcome_pending" \
                    and current.get("payload") == outbox["payload"]:
                persist_command_outbox(None)
                state["commandOutbox"] = None
                if state.get("command") and state["command"].get("id") == outbox["commandId"]:
                    state["command"] = None
        return result, response_correlation_id
    if not pending:
        return False
    result, response_correlation_id = api(
        pending["payload"], pending.get("correlationId"),
    )
    if not isinstance(result, dict) or result.get("completed") is not True \
            or not isinstance(result.get("replayed"), bool):
        raise ValueError("Managed completion acknowledgement is invalid")
    with lock:
        current = state.get("pendingCompletion")
        if current and current["payload"]["commandId"] == pending["payload"]["commandId"]:
            persist_pending_completion(None)
            state["pendingCompletion"] = None
            if state.get("command") and state["command"].get("id") == pending["payload"]["commandId"]:
                state["command"] = None
    return result, response_correlation_id


def accept_browser_completion(payload, api=api_call):
    with lock:
        outbox = state.get("commandOutbox")
    if outbox is not None:
        completion = _completion_payload(payload)
        command_id = completion["commandId"]
        with lock:
            current = state.get("commandOutbox")
            if not current or current["commandId"] != command_id \
                    or current["generation"] != completion.get("claimGeneration") \
                    or current["phase"] not in {"executing", "outcome_unknown"}:
                raise ValueError("Managed command execution is not awaiting an outcome")
            pending = {
                **current,
                "phase": "outcome_pending",
                "payload": completion,
            }
            if current.get("protocolVersion") == 1:
                pending["payload"] = {**completion, "protocolVersion": 1}
            state["commandOutbox"] = pending
            persist_command_outbox(pending)
        return retry_pending_completion(api=api)
    completion = _completion_payload(payload)
    command_id = completion["commandId"]
    with lock:
        expected = state.get("command") and state["command"].get("id")
        pending = state.get("pendingCompletion")
        if pending:
            if pending["payload"] != completion:
                raise ValueError("Command completion conflicts with its pending outcome")
        else:
            if not expected or command_id != expected:
                raise ValueError("Command is no longer pending")
            state["pendingCompletion"] = {
                "payload": completion,
                "correlationId": state["command"].get("correlationId"),
            }
            pending = state["pendingCompletion"]
        persist_pending_completion(pending)
    return retry_pending_completion(api=api)


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
            retry_unresolved_execution()
            retry_pending_completion()
            payload, request_correlation_id = api_call({"action": "poll"})
            protocol_version = payload.get("protocolVersion") \
                if payload.get("protocolVersion") in {2, 3, 4} else 1
            lease = payload.get("lease")
            command = payload.get("command")
            if command:
                command["correlationId"] = request_correlation_id
                with lock:
                    outbox = state.get("commandOutbox")
                if outbox is None or (
                    outbox.get("phase") == "claim_pending"
                    and outbox.get("commandId") == command.get("id")
                ):
                    claim_polled_command(command, request_correlation_id, protocol_version=protocol_version)
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
        if self.path not in {"/begin", "/complete", "/unknown", "/readiness"}:
            return self._send(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4096:
                raise ValueError("Request size is invalid")
            payload = json.loads(self.rfile.read(length))
            if self.path == "/readiness":
                record_browser_readiness(payload)
                return self._send(200, {"ok": True})
            if self.path == "/begin":
                result = accept_browser_begin(payload)
                return self._send(200, result)
            if self.path == "/unknown":
                result = accept_browser_unknown(payload)
                return self._send(200, result)
            reported_device = payload.get("deviceId")
            if isinstance(reported_device, str) and len(reported_device) <= 200:
                device_id = reported_device
            result, response_correlation_id = accept_browser_completion(payload)
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
    load_durable_command_state()
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
