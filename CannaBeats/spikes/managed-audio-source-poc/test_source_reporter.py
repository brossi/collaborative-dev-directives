import io
import json
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from source_reporter import (
    MAX_SAFE_INTEGER,
    PublisherSnapshotClient,
    SourceGameClient,
    SourceReporter,
    SourceReporterError,
    validate_publisher_snapshot,
)


INSTANCE_A = "11111111-1111-4111-8111-111111111111"
INSTANCE_B = "22222222-2222-4222-8222-222222222222"
GRANT = "33333333-3333-4333-8333-333333333333"
TRACE = "44444444-4444-4444-8444-444444444444"
SAMPLE = "55555555-5555-4555-8555-555555555555"


def snapshot(instance_id=INSTANCE_A, **changes):
    value = {
        "interface": "btaudio-publisher-diagnostics/v1",
        "schemaVersion": 1,
        "instanceId": instance_id,
        "sampleRate": 48000,
        "channels": 2,
        "encoding": "s16le",
        "capturedFrames": 480000,
        "enqueuedFrames": 480000,
        "publishedFrames": 480000,
        "publishedBytes": 1920000,
        "captureGapCount": 0,
        "droppedUploadCount": 0,
        "reconnectCount": 0,
        "publisherRestartCount": 0,
        "publisherState": "publishing",
    }
    value.update(changes)
    return value


class Clock:
    def __init__(self, milliseconds=1000.0):
        self.milliseconds = milliseconds

    def ms(self):
        return self.milliseconds

    def ns(self):
        return int(self.milliseconds * 1_000_000)

    def advance(self, milliseconds):
        self.milliseconds += milliseconds


class Publisher:
    def __init__(self, *values):
        self.values = list(values)
        self.last = self.values[-1] if self.values else snapshot()

    def snapshot(self):
        if self.values:
            self.last = self.values.pop(0)
        if isinstance(self.last, Exception):
            raise self.last
        return validate_publisher_snapshot(dict(self.last))


class Game:
    def __init__(self, clock):
        self.clock = clock
        self.opens = []
        self.syncs = []
        self.reports = []
        self.outcomes = []

    def open(self, request_id, instance_id):
        self.opens.append((request_id, instance_id))
        return {
            "status": "opened", "sourceGrantId": GRANT, "traceId": TRACE,
            "sourceInstanceId": instance_id, "expiresAtMs": 100000,
        }

    def synchronize(self, request_id, grant_id, instance_id, _monotonic_ms):
        self.syncs.append((request_id, grant_id, instance_id))
        return ({
            "status": "accepted", "sourceGrantId": grant_id, "sampleId": SAMPLE,
            "timebaseId": TRACE, "instanceId": instance_id,
            "serverReceiveMs": 10, "serverSendMs": 10,
        }, {
            "sampleId": SAMPLE, "instanceId": instance_id,
            "localSendMs": self.clock.ms(), "localReceiveMs": self.clock.ms(),
        })

    def report(self, grant_id, core, observation):
        self.reports.append(json.loads(json.dumps({
            "grant": grant_id, "core": core, "observation": observation,
        })))
        if self.outcomes:
            outcome = self.outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return {"status": outcome} if outcome not in {"accepted", "replayed"} else {
                "status": outcome, "receivedAt": 100,
            }
        return {"status": "accepted", "receivedAt": 100}


def reporter(publisher, game, clock, playback=lambda: "playing", logs=None):
    return SourceReporter(
        publisher, game, playback, monotonic_ms=clock.ms, monotonic_ns=clock.ns,
        logger=(logs if logs is not None else []).append,
    )


class PublisherContractTests(unittest.TestCase):
    def test_snapshot_exact_shape_relations_and_boundaries(self):
        self.assertEqual(validate_publisher_snapshot(snapshot())["publisherState"], "publishing")
        valid = snapshot(capturedFrames=MAX_SAFE_INTEGER, enqueuedFrames=1,
                         publishedFrames=1, publishedBytes=4)
        self.assertEqual(validate_publisher_snapshot(valid)["capturedFrames"], MAX_SAFE_INTEGER)
        invalid = [
            {**snapshot(), "peer": "private"},
            {key: value for key, value in snapshot().items() if key != "publisherState"},
            snapshot(publishedFrames=2, enqueuedFrames=1, publishedBytes=8),
            snapshot(publishedBytes=3),
            snapshot(capturedFrames=MAX_SAFE_INTEGER + 1),
            snapshot(instanceId=str(uuid.uuid1())),
        ]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaisesRegex(SourceReporterError, "response_invalid"):
                    validate_publisher_snapshot(value)

    def test_unix_client_enforces_response_size_and_deadline(self):
        def serve(path, payload=None, hold=None):
            ready = threading.Event()

            def owner():
                server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                server.bind(str(path))
                server.listen(1)
                ready.set()
                connection, _ = server.accept()
                connection.recv(512)
                if hold is not None:
                    hold.wait(1)
                elif payload is not None:
                    connection.sendall(payload)
                connection.close()
                server.close()

            thread = threading.Thread(target=owner, daemon=True)
            thread.start()
            self.assertTrue(ready.wait(0.2))
            return thread

        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "publisher.sock"
            thread = serve(path, b"x" * 2049)
            with self.assertRaisesRegex(SourceReporterError, "response_invalid"):
                PublisherSnapshotClient(path).snapshot()
            thread.join(0.2)

            path.unlink(missing_ok=True)
            hold = threading.Event()
            thread = serve(path, hold=hold)
            with self.assertRaisesRegex(SourceReporterError, "unavailable"):
                PublisherSnapshotClient(path, timeout=0.01).snapshot()
            hold.set()
            thread.join(0.2)

            path.unlink(missing_ok=True)
            valid = json.dumps({"status": "ok", "snapshot": snapshot()}).encode()
            thread = serve(path, valid + b"\n{}")
            with self.assertRaisesRegex(SourceReporterError, "response_invalid"):
                PublisherSnapshotClient(path).snapshot()
            thread.join(0.2)

            path.unlink(missing_ok=True)
            duplicate = b'{"status":"unavailable","status":"ok","snapshot":{}}\n'
            thread = serve(path, duplicate)
            with self.assertRaisesRegex(SourceReporterError, "response_invalid"):
                PublisherSnapshotClient(path).snapshot()
            thread.join(0.2)


class GameClientBoundaryTests(unittest.TestCase):
    def test_open_only_request_conflict_is_not_a_report_result(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _amount):
                return b'{"status":"request_conflict"}'

        client = SourceGameClient(
            "https://example.invalid", lambda: "a" * 32,
            opener=lambda *_args, **_kwargs: Response(),
        )
        with self.assertRaisesRegex(SourceReporterError, "response_invalid"):
            client.report(GRANT, {}, {})

    def test_http_errors_require_bounded_exact_canonical_code_status_pairs(self):
        def failure(status, body):
            return urllib.error.HTTPError(
                "https://example.invalid", status, "ignored", {}, io.BytesIO(body),
            )

        canonical = json.dumps({
            "error": "Diagnostics are temporarily unavailable.",
            "code": "report_invalid",
        }).encode()
        self.assertEqual(
            SourceGameClient._http_failure(failure(400, canonical)).code,
            "report_invalid",
        )
        malformed = [
            canonical + b" " * (8193 - len(canonical)),
            json.dumps({
                "error": "Diagnostics are temporarily unavailable.",
                "code": "report_invalid", "extra": "private",
            }).encode(),
            json.dumps({
                "error": "Diagnostics are temporarily unavailable.",
                "code": "report_invalid",
            }).encode(),
            b'{"error":"Diagnostics are temporarily unavailable.",'
            b'"code":"diagnostic_unavailable","code":"report_invalid"}',
        ]
        statuses = (400, 400, 503, 400)
        for status, body in zip(statuses, malformed):
            with self.subTest(status=status, size=len(body)):
                self.assertEqual(
                    SourceGameClient._http_failure(failure(status, body)).code,
                    "response_invalid",
                )

    def test_each_new_transaction_reads_the_current_source_credential(self):
        seen = []
        tokens = iter(("a" * 32, "b" * 32))

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _amount):
                return json.dumps({
                    "status": "opened", "sourceGrantId": GRANT, "traceId": TRACE,
                    "sourceInstanceId": INSTANCE_A, "expiresAtMs": 100,
                }).encode()

        def opener(request, **_kwargs):
            seen.append(request.headers["Authorization"])
            return Response()

        client = SourceGameClient(
            "https://example.invalid", lambda: next(tokens), opener=opener,
        )
        client.open(str(uuid.uuid4()), INSTANCE_A)
        client.open(str(uuid.uuid4()), INSTANCE_A)
        self.assertEqual(seen, [f"Bearer {'a' * 32}", f"Bearer {'b' * 32}"])

    def test_strict_deadline_retains_only_one_exact_inflight_request(self):
        release = threading.Event()
        calls = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _amount):
                return json.dumps({
                    "status": "opened", "sourceGrantId": GRANT, "traceId": TRACE,
                    "sourceInstanceId": INSTANCE_A, "expiresAtMs": 100,
                }).encode()

        def opener(request, timeout):
            calls.append((request.data, request.headers["Authorization"], timeout))
            release.wait()
            return Response()

        client = SourceGameClient(
            "https://example.invalid", lambda: "a" * 32, timeout=0.01, opener=opener,
        )
        request_id = str(uuid.uuid4())
        for _ in range(2):
            with self.assertRaisesRegex(SourceReporterError, "request_timeout"):
                client.open(request_id, INSTANCE_A)
        self.assertEqual(len(calls), 1)
        release.set()
        self.assertTrue(client._inflight["result"]["done"].wait(1))
        self.assertEqual(client.open(request_id, INSTANCE_A)["status"], "opened")
        self.assertEqual(len(calls), 1)

    def test_synchronization_retry_keeps_original_exchange_timestamps(self):
        release = threading.Event()
        current = [100.0]

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _amount):
                return json.dumps({
                    "status": "accepted", "sourceGrantId": GRANT, "sampleId": SAMPLE,
                    "timebaseId": TRACE, "instanceId": INSTANCE_A,
                    "serverReceiveMs": 10, "serverSendMs": 11,
                }).encode()

        def opener(*_args, **_kwargs):
            release.wait()
            return Response()

        client = SourceGameClient(
            "https://example.invalid", lambda: "a" * 32,
            timeout=0.01, opener=opener,
        )
        request_id = str(uuid.uuid4())
        with self.assertRaisesRegex(SourceReporterError, "request_timeout"):
            client.synchronize(request_id, GRANT, INSTANCE_A, lambda: current[0])
        current[0] = 150.0
        release.set()
        self.assertTrue(client._inflight["result"]["done"].wait(1))
        current[0] = 1000.0
        _sample, observation = client.synchronize(
            request_id, GRANT, INSTANCE_A, lambda: current[0],
        )
        self.assertEqual(observation["localSendMs"], 100.0)
        self.assertEqual(observation["localReceiveMs"], 150.0)

    def test_completed_superseded_helper_does_not_block_new_instance(self):
        release = threading.Event()
        calls = []

        class Response:
            def __init__(self, instance_id):
                self.instance_id = instance_id

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _amount):
                return json.dumps({
                    "status": "opened", "sourceGrantId": GRANT, "traceId": TRACE,
                    "sourceInstanceId": self.instance_id, "expiresAtMs": 100,
                }).encode()

        def opener(request, **_kwargs):
            body = json.loads(request.data)
            calls.append(body["sourceInstanceId"])
            if len(calls) == 1:
                release.wait()
            return Response(body["sourceInstanceId"])

        client = SourceGameClient(
            "https://example.invalid", lambda: "a" * 32,
            timeout=0.01, opener=opener,
        )
        with self.assertRaisesRegex(SourceReporterError, "request_timeout"):
            client.open(str(uuid.uuid4()), INSTANCE_A)
        release.set()
        self.assertTrue(client._inflight["result"]["done"].wait(1))
        result = client.open(str(uuid.uuid4()), INSTANCE_B)
        self.assertEqual(result["sourceInstanceId"], INSTANCE_B)
        self.assertEqual(calls, [INSTANCE_A, INSTANCE_B])

    def test_synchronization_rejects_server_work_beyond_local_rtt(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _amount):
                return json.dumps({
                    "status": "accepted", "sourceGrantId": GRANT, "sampleId": SAMPLE,
                    "timebaseId": TRACE, "instanceId": INSTANCE_A,
                    "serverReceiveMs": 10, "serverSendMs": 13,
                }).encode()

        client = SourceGameClient(
            "https://example.invalid", lambda: "b" * 32,
            opener=lambda *_args, **_kwargs: Response(),
        )
        times = iter((100.0, 102.0))
        with self.assertRaisesRegex(SourceReporterError, "response_invalid"):
            client.synchronize(str(uuid.uuid4()), GRANT, INSTANCE_A, lambda: next(times))

    def test_synchronization_rejects_noncanonical_server_clock_scalars(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _amount):
                return json.dumps({
                    "status": "accepted", "sourceGrantId": GRANT, "sampleId": SAMPLE,
                    "timebaseId": TRACE, "instanceId": INSTANCE_A,
                    "serverReceiveMs": 10.5, "serverSendMs": 10.5,
                }).encode()

        client = SourceGameClient(
            "https://example.invalid", lambda: "b" * 32,
            opener=lambda *_args, **_kwargs: Response(),
        )
        times = iter((100.0, 101.0))
        with self.assertRaisesRegex(SourceReporterError, "response_invalid"):
            client.synchronize(str(uuid.uuid4()), GRANT, INSTANCE_A, lambda: next(times))


class ReporterLifecycleTests(unittest.TestCase):
    def test_lost_synchronization_response_reuses_request_and_sequence(self):
        class SyncLossGame(Game):
            def __init__(self, clock):
                super().__init__(clock)
                self.fail = True

            def synchronize(self, request_id, grant_id, instance_id, monotonic_ms):
                self.syncs.append((request_id, grant_id, instance_id))
                if self.fail:
                    self.fail = False
                    raise SourceReporterError("request_timeout")
                return super().synchronize(
                    request_id, grant_id, instance_id, monotonic_ms,
                )

        clock = Clock()
        game = SyncLossGame(clock)
        owner = reporter(Publisher(snapshot()), game, clock)
        owner.tick()
        reserved = owner.pending_sync["sequence"]
        owner.tick()
        self.assertEqual(game.syncs[0][0], game.syncs[1][0])
        self.assertEqual(owner.window_sequence, reserved)

    def test_synchronization_timebase_is_bound_to_the_opened_trace(self):
        class WrongTraceGame(Game):
            def synchronize(self, request_id, grant_id, instance_id, monotonic_ms):
                sample, observation = super().synchronize(
                    request_id, grant_id, instance_id, monotonic_ms,
                )
                return {**sample, "timebaseId": str(uuid.uuid4())}, observation

        clock = Clock()
        game = WrongTraceGame(clock)
        logs = []
        owner = reporter(Publisher(snapshot()), game, clock, logs=logs)
        owner.tick()
        self.assertIsNone(owner.sample)
        self.assertIsNotNone(owner.pending_sync)
        self.assertEqual(logs, ["response_invalid"])

    def test_nine_second_window_and_observed_transition_are_ordered_and_e1_valid(self):
        clock = Clock()
        game = Game(clock)
        owner = reporter(Publisher(
            snapshot(publisherState="connecting"), snapshot(publisherState="publishing"),
        ), game, clock)

        owner.tick()
        clock.advance(9000)
        owner.tick()
        owner.tick()

        self.assertEqual([row["core"]["kind"] for row in game.reports], [
            "source_window", "source_transition",
        ])
        self.assertLess(game.reports[0]["core"]["sequence"], game.reports[1]["core"]["sequence"])
        self.assertEqual(game.reports[0]["core"]["durationMs"], 9000)
        self.assertEqual(game.reports[1]["core"]["measurements"], {
            "type": "publisher_started", "category": "observed",
        })

        contract = pathlib.Path(__file__).parents[2] / "web/lib/s2e-e1-contract.mjs"
        script = (
            f'import {{validateMeasurementJson}} from {json.dumps(contract.as_uri())};'
            "const chunks=[];for await(const c of process.stdin)chunks.push(c);"
            "const v=JSON.parse(Buffer.concat(chunks));"
            "for(const r of v)validateMeasurementJson(Buffer.from(JSON.stringify(r)));"
        )
        checked = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            input=json.dumps([row["core"] for row in game.reports]).encode(),
            check=False, capture_output=True,
        )
        self.assertEqual(checked.returncode, 0, checked.stderr.decode())

    def test_ten_second_boundary_is_kept_and_later_interval_is_a_gap(self):
        for elapsed, expected_reports in ((10000, 1), (10000.001, 0)):
            with self.subTest(elapsed=elapsed):
                clock = Clock()
                game = Game(clock)
                logs = []
                owner = reporter(Publisher(snapshot(), snapshot()), game, clock, logs=logs)
                owner.tick()
                clock.advance(elapsed)
                owner.tick()
                self.assertEqual(len(game.reports), expected_reports)
                self.assertEqual("coverage_gap" in logs, expected_reports == 0)

    def test_instance_change_discards_old_window_and_reopens(self):
        clock = Clock()
        game = Game(clock)
        owner = reporter(Publisher(snapshot(), snapshot(INSTANCE_B)), game, clock)
        owner.tick()
        clock.advance(9000)
        owner.tick()
        self.assertEqual(game.reports, [])
        self.assertEqual([value[1] for value in game.opens], [INSTANCE_A, INSTANCE_B])
        self.assertEqual(owner.instance_id, INSTANCE_B)

    def test_same_instance_counter_regression_never_becomes_a_report(self):
        clock = Clock()
        game = Game(clock)
        logs = []
        owner = reporter(Publisher(
            snapshot(), snapshot(capturedFrames=479999, enqueuedFrames=479999,
                                 publishedFrames=479999, publishedBytes=1919996),
        ), game, clock, logs=logs)
        owner.tick()
        clock.advance(9000)
        owner.tick()
        self.assertEqual(game.reports, [])
        self.assertEqual(logs, ["response_invalid"])

    def test_outcome_unknown_retries_exact_bytes_before_new_evidence(self):
        clock = Clock()
        game = Game(clock)
        game.outcomes = [SourceReporterError("unavailable"), "accepted"]
        owner = reporter(Publisher(snapshot(), snapshot()), game, clock)
        owner.tick()
        clock.advance(9000)
        owner.tick()
        self.assertIsNotNone(owner.pending_window)
        owner.tick()
        self.assertEqual(game.reports[0], game.reports[1])
        self.assertIsNone(owner.pending_window)
        self.assertEqual(len(game.syncs), 1)

    def test_terminal_correlation_loss_clears_only_reporter_state(self):
        clock = Clock()
        game = Game(clock)
        game.outcomes = ["stale_correlation"]
        owner = reporter(Publisher(snapshot(), snapshot()), game, clock)
        owner.tick()
        clock.advance(9000)
        owner.tick()
        self.assertIsNone(owner.grant)
        self.assertIsNone(owner.pending_window)
        owner.tick()
        self.assertEqual(len(game.opens), 2)
        self.assertNotEqual(game.opens[0][0], game.opens[1][0])
        self.assertIsNone(owner.deferred_transition)

    def test_credential_scope_loss_reopens_with_a_fresh_request_generation(self):
        clock = Clock()
        game = Game(clock)
        game.outcomes = [SourceReporterError("diagnostic_not_found")]
        owner = reporter(Publisher(snapshot(), snapshot()), game, clock)
        owner.tick()
        clock.advance(9000)
        owner.tick()
        self.assertIsNone(owner.grant)
        owner.tick()
        self.assertEqual(len(game.opens), 2)
        self.assertNotEqual(game.opens[0][0], game.opens[1][0])

    def test_restart_credential_conflict_advances_only_open_generation(self):
        class ConflictOnceGame(Game):
            def open(self, request_id, instance_id):
                self.opens.append((request_id, instance_id))
                if len(self.opens) == 1:
                    raise SourceReporterError("request_conflict")
                return {
                    "status": "opened", "sourceGrantId": GRANT, "traceId": TRACE,
                    "sourceInstanceId": instance_id, "expiresAtMs": 100000,
                }

        clock = Clock()
        game = ConflictOnceGame(clock)
        owner = reporter(Publisher(snapshot()), game, clock)
        owner.tick()
        self.assertIsNone(owner.grant)
        owner.tick()
        self.assertIsNotNone(owner.grant)
        self.assertNotEqual(game.opens[0][0], game.opens[1][0])

    def test_locally_invalid_report_result_is_dropped_instead_of_retried_forever(self):
        clock = Clock()
        game = Game(clock)
        game.outcomes = ["report_invalid"]
        owner = reporter(Publisher(snapshot(), snapshot()), game, clock)
        owner.tick()
        clock.advance(9000)
        owner.tick()
        self.assertIsNone(owner.pending_window)
        self.assertEqual(len(game.reports), 1)

    def test_quota_and_conflict_retire_only_the_current_evidence(self):
        for outcome in ("quota_exhausted", "report_conflict"):
            with self.subTest(outcome=outcome):
                clock = Clock()
                game = Game(clock)
                game.outcomes = [outcome]
                owner = reporter(Publisher(snapshot(), snapshot()), game, clock)
                owner.tick()
                clock.advance(9000)
                owner.tick()
                self.assertIsNone(owner.pending_window)
                self.assertIsNotNone(owner.grant)
                owner.tick()
                self.assertEqual(len(game.syncs), 2)

    def test_simultaneous_transition_evidence_uses_the_fixed_priority(self):
        clock = Clock()
        game = Game(clock)
        owner = reporter(Publisher(
            snapshot(publisherState="connecting"),
            snapshot(publisherRestartCount=1, publisherState="publishing"),
        ), game, clock, playback=lambda: "error")
        owner.tick()
        clock.advance(9000)
        owner.tick()
        self.assertEqual(owner.pending_transition["core"]["measurements"], {
            "type": "publisher_restarted", "category": "error",
            "reason": "publisher_unavailable",
        })

    def test_restart_sequence_stride_advances_without_a_journal(self):
        first_clock = Clock(1000.000)
        second_clock = Clock(1000.001)
        first = reporter(Publisher(snapshot()), Game(first_clock), first_clock)
        second = reporter(Publisher(snapshot()), Game(second_clock), second_clock)
        first_sequence = first._sequence()
        self.assertEqual(first._sequence(), first_sequence + 1)
        self.assertGreater(second._sequence(), first.last_sequence)

    def test_unexpected_dependency_exception_stays_inside_reporter_thread(self):
        class Broken:
            def snapshot(self):
                raise RuntimeError("private native text")

        class OneWait:
            def __init__(self):
                self.stopped = False

            def is_set(self):
                return self.stopped

            def wait(self, _delay):
                self.stopped = True

        logs = []
        owner = reporter(Broken(), Game(Clock()), Clock(), logs=logs)
        owner.run(OneWait())
        self.assertEqual(logs, ["unavailable"])


if __name__ == "__main__":
    unittest.main()
