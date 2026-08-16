import importlib.util
import pathlib
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch


MODULE_PATH = pathlib.Path(__file__).with_name("controller.py")
SPEC = importlib.util.spec_from_file_location("cannabeats_source_controller", MODULE_PATH)
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)


class SourceDiagnosticsObservationTests(unittest.TestCase):
    def setUp(self):
        with controller.lock:
            controller.state["browserReport"] = None

    def test_readiness_accepts_only_the_exact_finite_observation(self):
        controller.record_browser_readiness({
            "spotifyAuthorization": "authorized",
            "player": "ready",
            "playbackObservation": "playing",
            "playbackObservationAgeMs": 0,
        })
        self.assertEqual(controller.controller_playback_snapshot(), "playing")
        for invalid in (
            {"spotifyAuthorization": "authorized", "player": "ready"},
            {"spotifyAuthorization": "authorized", "player": "ready",
             "playbackObservation": "playing", "playbackObservationAgeMs": 0,
             "track": "private"},
            {"spotifyAuthorization": "authorized", "player": "ready",
             "playbackObservation": "buffering", "playbackObservationAgeMs": 0},
            {"spotifyAuthorization": "authorized", "player": "not_ready",
             "playbackObservation": "playing", "playbackObservationAgeMs": 0},
            {"spotifyAuthorization": "authorized", "player": "ready",
             "playbackObservation": "playing", "playbackObservationAgeMs": 15001},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                controller.record_browser_readiness(invalid)

    def test_stale_observation_becomes_unknown_without_mutating_browser_state(self):
        with patch.object(controller.time, "monotonic", return_value=10.0):
            controller.record_browser_readiness({
                "spotifyAuthorization": "authorized",
                "player": "ready",
                "playbackObservation": "paused",
                "playbackObservationAgeMs": 0,
            })
        with patch.object(
            controller.time, "monotonic",
            return_value=10.0 + controller.BROWSER_REPORT_STALE_SECONDS,
        ):
            self.assertEqual(controller.controller_playback_snapshot(), "paused")
        with patch.object(
            controller.time, "monotonic",
            return_value=10.001 + controller.BROWSER_REPORT_STALE_SECONDS,
        ):
            self.assertEqual(controller.controller_playback_snapshot(), "unknown")
        with controller.lock:
            self.assertEqual(controller.state["browserReport"]["playbackObservation"], "paused")

    def test_fresh_heartbeat_cannot_refresh_an_old_playback_event(self):
        with patch.object(controller.time, "monotonic", return_value=100.0):
            controller.record_browser_readiness({
                "spotifyAuthorization": "authorized",
                "player": "ready",
                "playbackObservation": "playing",
                "playbackObservationAgeMs": 15000,
            })
        with patch.object(controller.time, "monotonic", return_value=100.001):
            self.assertEqual(controller.controller_playback_snapshot(), "unknown")

    def test_reporter_log_maps_arbitrary_text_to_one_finite_reason(self):
        controller.last_reporter_error = None
        with patch.object(controller, "operational_log") as log:
            controller.reporter_log("/private/path secret-token")
        self.assertEqual(log.call_args.kwargs["reasonCode"], "unavailable")

    def test_held_reporter_dependency_cannot_delay_poll_or_fail_close(self):
        entered = threading.Event()
        release = threading.Event()

        class HeldPublisher:
            def snapshot(self):
                entered.set()
                release.wait(1)
                raise RuntimeError("diagnostics only")

        reporter = controller.SourceReporter(
            HeldPublisher(), Mock(), lambda: "unknown",
        )
        reporter_stop = threading.Event()
        worker = threading.Thread(target=reporter.run, args=(reporter_stop,), daemon=True)
        worker.start()
        self.assertTrue(entered.wait(0.2))

        with controller.lock:
            controller.state.update({
                "lease": {"id": "lease"}, "command": None,
                "lastError": None, "lastSuccessfulPoll": 0.0,
            })
        with patch.object(controller, "retry_unresolved_execution"), \
                patch.object(controller, "retry_pending_completion"), \
                patch.object(controller, "api_call", side_effect=OSError("game down")), \
                patch.object(controller, "set_relay") as relay, \
                patch.object(controller, "operational_log"), \
                patch.object(controller.time, "monotonic", return_value=26.0), \
                patch.object(controller.time, "sleep", side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                controller.poll_loop()
        relay.assert_called_once_with(False)
        with controller.lock:
            self.assertIsNone(controller.state["lease"])
        release.set()
        reporter_stop.set()
        worker.join(0.2)


class CompletionAcknowledgementTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        controller.PENDING_COMPLETION_PATH = pathlib.Path(self.directory.name) / "pending.json"
        with controller.lock:
            controller.state.update({
                "lease": {"id": "lease-1", "sessionCode": "TEST23"},
                "command": {
                    "id": "command-1",
                    "kind": "play",
                    "correlationId": "00000000-0000-4000-8000-000000000001",
                },
                "pendingCompletion": None,
                "commandOutbox": None,
                "recoveryGeneration": None,
                "relayActive": True,
                "lastError": None,
                "lastSuccessfulPoll": 1.0,
                "browserReport": None,
            })

    def tearDown(self):
        self.directory.cleanup()

    def test_lost_ack_retains_the_executed_outcome_and_hides_command_from_browser(self):
        unavailable = Mock(side_effect=OSError("completion response lost"))
        payload = {
            "commandId": "command-1",
            "ok": True,
            "playbackStatus": "playing",
            "deviceId": "private-provider-device-id",
        }

        with self.assertRaises(OSError):
            controller.accept_browser_completion(payload, api=unavailable)

        self.assertIsNone(controller.public_state()["command"])
        self.assertEqual(controller.PENDING_COMPLETION_PATH.stat().st_mode & 0o777, 0o600)
        with controller.lock:
            self.assertEqual(
                controller.state["pendingCompletion"]["payload"]["commandId"], "command-1"
            )

        accepted = Mock(return_value=({"completed": True, "replayed": True}, "correlation-2"))
        self.assertTrue(controller.retry_pending_completion(api=accepted))
        sent = accepted.call_args.args[0]
        self.assertNotIn("deviceId", sent)
        self.assertEqual(sent["commandId"], "command-1")
        with controller.lock:
            self.assertIsNone(controller.state["pendingCompletion"])
            self.assertIsNone(controller.state["command"])

    def test_pending_outcome_survives_controller_state_reload(self):
        unavailable = Mock(side_effect=OSError("completion response lost"))
        with self.assertRaises(OSError):
            controller.accept_browser_completion({
                "commandId": "command-1",
                "ok": True,
                "playbackStatus": "playing",
            }, api=unavailable)

        with controller.lock:
            controller.state["pendingCompletion"] = None
        controller.load_pending_completion()

        self.assertIsNone(controller.public_state()["command"])
        with controller.lock:
            self.assertEqual(
                controller.state["pendingCompletion"]["payload"]["commandId"], "command-1"
            )

    def test_invalid_success_response_does_not_discard_pending_outcome(self):
        unavailable = Mock(side_effect=OSError("completion response lost"))
        with self.assertRaises(OSError):
            controller.accept_browser_completion({
                "commandId": "command-1",
                "ok": True,
                "playbackStatus": "playing",
            }, api=unavailable)

        for body in ({}, {"completed": False}, {"error": "conflict"}):
            with self.assertRaises(ValueError):
                controller.retry_pending_completion(
                    api=Mock(return_value=(body, "correlation-2")),
                )
            with controller.lock:
                self.assertIsNotNone(controller.state["pendingCompletion"])

    def test_service_grants_only_its_private_state_directory_for_pending_outcomes(self):
        unit = (MODULE_PATH.parent / "infra" / "cannabeats-source-controller.service").read_text()
        self.assertIn(
            "CANNABEATS_PENDING_COMPLETION_FILE=/var/lib/cannabeats-controller/pending-completion.json",
            unit,
        )
        self.assertIn("ReadWritePaths=/var/lib/cannabeats-controller", unit)

    def test_execution_is_durable_before_the_browser_may_call_spotify(self):
        generation = "00000000-0000-4000-8000-000000000011"
        command_id = "00000000-0000-4000-8000-000000000012"
        outbox = {
            "generation": generation,
            "commandId": command_id,
            "phase": "claimed",
            "command": {"id": command_id, "kind": "play"},
            "correlationId": None,
        }
        with controller.lock:
            controller.state["commandOutbox"] = outbox
        controller.persist_command_outbox(outbox)

        observed = []
        def begin_api(payload, _correlation=None):
            observed.append(controller.load_command_outbox()["phase"])
            return {"accepted": True, "status": "executing", "replayed": False}, None

        result = controller.accept_browser_begin({
            "commandId": command_id, "claimGeneration": generation,
        }, api=begin_api)
        self.assertTrue(result["accepted"])
        self.assertEqual(observed, ["executing"])

        with controller.lock:
            controller.state["commandOutbox"] = None
        controller.load_command_outbox()
        self.assertIsNone(controller.public_state()["command"])
        self.assertEqual(controller.public_state()["commandRecovery"]["status"], "outcome_unknown")

    def test_claim_is_durable_before_the_game_api_claim(self):
        command_id = "00000000-0000-4000-8000-000000000013"
        observed = []
        def claim_api(payload, _correlation=None):
            saved = controller.load_command_outbox()
            observed.append((saved["phase"], saved["generation"], payload["claimGeneration"]))
            return {"accepted": True, "status": "claimed", "replayed": False}, None

        result = controller.claim_polled_command(
            {"id": command_id, "kind": "play", "trackUri": "spotify:track:test"},
            api=claim_api,
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(observed[0][0], "claim_pending")
        self.assertEqual(observed[0][1], observed[0][2])
        self.assertEqual(controller.public_state()["command"]["claimGeneration"], observed[0][1])

    def test_claim_response_loss_retries_the_same_durable_generation(self):
        command_id = "00000000-0000-4000-8000-000000000045"
        command = {"id": command_id, "kind": "pause", "trackUri": None, "recovery": True}
        lost = Mock(side_effect=OSError("claim response lost"))
        with self.assertRaises(OSError):
            controller.claim_polled_command(command, api=lost, protocol_version=4)
        pending = controller.load_command_outbox()
        self.assertEqual(pending["phase"], "claim_pending")

        accepted = Mock(return_value=(
            {"accepted": True, "status": "claimed", "replayed": True}, None,
        ))
        controller.claim_polled_command(command, api=accepted, protocol_version=4)
        self.assertEqual(
            accepted.call_args.args[0]["claimGeneration"], pending["generation"],
        )
        self.assertEqual(controller.load_command_outbox()["phase"], "claimed")

    def test_expiry_after_lost_claim_adopts_state_unknown_before_handoff_work(self):
        command_id = "00000000-0000-4000-8000-000000000046"
        with self.assertRaises(OSError):
            controller.claim_polled_command(
                {"id": command_id,"kind": "resume","trackUri": None},
                api=Mock(side_effect=OSError("claim response lost")),protocol_version=4,
            )
        pending = controller.load_command_outbox()
        self.assertTrue(controller.sync_authoritative_recovery({
            "protocolVersion": 4,"lease": None,"command": None,
            "recovery": {
                "commandId": command_id,"state": "outcome_unknown",
                "claimGeneration": pending["generation"],"kind": "resume","trackUri": None,
                "action": "reconcile_provider",
            },
        }))
        self.assertEqual(controller.load_command_outbox()["phase"],"outcome_unknown")
        self.assertEqual(controller.public_state()["commandRecovery"]["command"]["id"],command_id)

    def test_bridge_controller_executes_slice1_commands_without_claim_or_begin_calls(self):
        command_id = "00000000-0000-4000-8000-000000000025"
        api = Mock()
        result = controller.claim_polled_command(
            {"id": command_id, "kind": "play", "trackUri": "spotify:track:test"},
            api=api,
            protocol_version=1,
        )
        api.assert_not_called()
        controller.accept_browser_begin({
            "commandId": command_id, "claimGeneration": result["claimGeneration"],
        }, api=api)
        api.assert_not_called()

    def test_bridge_controller_accepts_slice1_completion_acknowledgement(self):
        command_id = "00000000-0000-4000-8000-000000000026"
        claimed = controller.claim_polled_command(
            {"id": command_id, "kind": "pause"},
            api=Mock(),
            protocol_version=1,
        )
        controller.accept_browser_begin({
            "commandId": command_id,
            "claimGeneration": claimed["claimGeneration"],
        }, api=Mock())
        old_api = Mock(return_value=({"completed": True}, None))
        controller.accept_browser_completion({
            "commandId": command_id,
            "claimGeneration": claimed["claimGeneration"],
            "ok": True,
            "playbackStatus": "paused",
        }, api=old_api)
        self.assertEqual(old_api.call_args.args[0]["protocolVersion"], 1)
        with controller.lock:
            self.assertIsNone(controller.state["commandOutbox"])

    def test_same_process_begin_failure_can_be_reconciled_as_unknown(self):
        command_id = "00000000-0000-4000-8000-000000000027"
        generation = "00000000-0000-4000-8000-000000000028"
        claimed = {
            "generation": generation,
            "commandId": command_id,
            "phase": "claimed",
            "command": {"id": command_id, "kind": "play"},
            "correlationId": None,
            "protocolVersion": 2,
        }
        with controller.lock:
            controller.state["commandOutbox"] = claimed
        controller.persist_command_outbox(claimed)
        with self.assertRaises(OSError):
            controller.accept_browser_begin({
                "commandId": command_id,
                "claimGeneration": generation,
            }, api=Mock(side_effect=OSError("begin response lost")))

        reconciliation = Mock(return_value=(
            {"accepted": True, "status": "outcome_unknown", "replayed": False}, None,
        ))
        self.assertEqual(controller.accept_browser_unknown({
            "commandId": command_id,
            "claimGeneration": generation,
        }, api=reconciliation), {"accepted": True, "status": "outcome_unknown"})
        self.assertEqual(reconciliation.call_args.args[0]["action"], "outcome_unknown")
        self.assertEqual(controller.load_command_outbox()["phase"], "outcome_unknown")

    def test_claim_does_not_advance_in_memory_or_contact_server_when_fsync_fails(self):
        command_id = "00000000-0000-4000-8000-000000000014"
        server = Mock()
        original = controller.persist_command_outbox
        controller.persist_command_outbox = Mock(side_effect=OSError("disk full"))
        try:
            with self.assertRaises(OSError):
                controller.claim_polled_command({"id": command_id, "kind": "play"}, api=server)
        finally:
            controller.persist_command_outbox = original
        server.assert_not_called()
        with controller.lock:
            self.assertIsNone(controller.state["commandOutbox"])
        self.assertFalse(controller.PENDING_COMPLETION_PATH.exists())

    def test_protocol_four_handoff_stop_is_claimed_without_a_live_lease(self):
        command_id = "00000000-0000-4000-8000-000000000044"
        source_api = Mock(return_value=(
            {"accepted": True, "status": "claimed", "replayed": False}, None,
        ))
        result = controller.claim_polled_command({
            "id": command_id,"kind": "pause","trackUri": None,"handoff": True,
        }, api=source_api, protocol_version=4)
        self.assertTrue(result["accepted"])
        self.assertEqual(source_api.call_args.args[0]["action"], "claim")
        with controller.lock:
            self.assertEqual(controller.state["commandOutbox"]["protocolVersion"], 4)
            self.assertTrue(controller.state["commandOutbox"]["command"]["handoff"])

    def test_source_protocol_negotiation_rejects_missing_future_and_unpublished_versions(self):
        self.assertEqual(controller.source_protocol_version({"protocolVersion": 1}), 1)
        self.assertEqual(controller.source_protocol_version({"protocolVersion": 2}), 2)
        self.assertEqual(controller.source_protocol_version({"protocolVersion": 4}), 4)
        for payload in [{}, {"protocolVersion": None}, {"protocolVersion": 3},
                        {"protocolVersion": 5}, {"protocolVersion": "4"}]:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    controller.source_protocol_version(payload)

    def test_restarted_executing_command_reports_unknown_to_server_once(self):
        generation = "00000000-0000-4000-8000-000000000015"
        command_id = "00000000-0000-4000-8000-000000000016"
        executing = {
            "generation": generation,
            "commandId": command_id,
            "phase": "executing",
            "command": {"id": command_id, "kind": "play"},
            "correlationId": None,
        }
        controller.persist_command_outbox(executing)
        controller.load_command_outbox()
        server = Mock(return_value=(
            {"accepted": True, "status": "outcome_unknown", "replayed": False}, None,
        ))
        self.assertTrue(controller.retry_unresolved_execution(api=server))
        self.assertEqual(server.call_args.args[0], {
            "action": "outcome_unknown",
            "commandId": command_id,
            "claimGeneration": generation,
            "requestId": controller.transition_request_id(
                "outcome_unknown", command_id, generation,
            ),
        })
        with controller.lock:
            self.assertEqual(controller.state["commandOutbox"]["phase"], "outcome_unknown")
        self.assertEqual(controller.load_command_outbox()["phase"], "outcome_unknown")
        self.assertFalse(controller.retry_unresolved_execution(api=server))
        self.assertEqual(server.call_count, 1)

    def test_current_process_execution_is_not_mistaken_for_restart_recovery(self):
        generation = "00000000-0000-4000-8000-000000000017"
        command_id = "00000000-0000-4000-8000-000000000018"
        claimed = {
            "generation": generation, "commandId": command_id, "phase": "claimed",
            "command": {"id": command_id, "kind": "play"}, "correlationId": None,
        }
        with controller.lock:
            controller.state["commandOutbox"] = claimed
        controller.persist_command_outbox(claimed)
        entered = threading.Event()
        release = threading.Event()

        def blocked_begin(_payload, _correlation=None):
            entered.set()
            release.wait(timeout=2)
            return {"accepted": True, "status": "executing", "replayed": False}, None

        worker = threading.Thread(
            target=controller.accept_browser_begin,
            args=({"commandId": command_id, "claimGeneration": generation},),
            kwargs={"api": blocked_begin},
        )
        worker.start()
        self.assertTrue(entered.wait(timeout=2))
        recovery = Mock()
        self.assertFalse(controller.retry_unresolved_execution(api=recovery))
        recovery.assert_not_called()
        release.set()
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())

    def test_exact_completion_reconciles_a_locally_unknown_outcome(self):
        generation = "00000000-0000-4000-8000-000000000019"
        command_id = "00000000-0000-4000-8000-000000000020"
        unknown = {
            "generation": generation, "commandId": command_id, "phase": "outcome_unknown",
            "command": {"id": command_id, "kind": "play"}, "correlationId": None,
        }
        with controller.lock:
            controller.state["commandOutbox"] = unknown
        controller.persist_command_outbox(unknown)
        self.assertEqual(controller.public_state()["commandRecovery"], {
            "status": "outcome_unknown",
            "reasonCode": "execution_started_without_durable_outcome",
            "command": {
                "id": command_id,"kind": "play","claimGeneration": generation,
            },
        })
        accepted = Mock(return_value=({"completed": True, "replayed": False}, None))
        controller.accept_browser_completion({
            "commandId": command_id, "claimGeneration": generation,
            "ok": True, "playbackStatus": "playing",
        }, api=accepted)
        self.assertEqual(accepted.call_args.args[0]["action"], "complete")
        with controller.lock:
            self.assertIsNone(controller.state["commandOutbox"])

    def test_old_acknowledgement_cannot_delete_a_newer_outbox_generation(self):
        generation_a = "00000000-0000-4000-8000-000000000021"
        generation_b = "00000000-0000-4000-8000-000000000022"
        command_a = "00000000-0000-4000-8000-000000000023"
        command_b = "00000000-0000-4000-8000-000000000024"
        old = {
            "generation": generation_a,
            "commandId": command_a,
            "phase": "outcome_pending",
            "payload": {
                "action": "complete", "commandId": command_a,
                "claimGeneration": generation_a, "ok": True, "playbackStatus": "playing",
                "error": None,
            },
            "correlationId": None,
        }
        with controller.lock:
            controller.state["commandOutbox"] = old
        controller.persist_command_outbox(old)
        entered = threading.Event()
        release = threading.Event()

        def slow_ack(_payload, _correlation=None):
            entered.set()
            release.wait(timeout=2)
            return {"completed": True, "replayed": False}, None

        worker = threading.Thread(target=controller.retry_pending_completion, kwargs={"api": slow_ack})
        worker.start()
        self.assertTrue(entered.wait(timeout=2))
        newer = {
            "generation": generation_b,
            "commandId": command_b,
            "phase": "executing",
            "command": {"id": command_b, "kind": "pause"},
            "correlationId": None,
        }
        with controller.lock:
            controller.state["commandOutbox"] = newer
            controller.persist_command_outbox(newer)
        release.set()
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())

        with controller.lock:
            controller.state["commandOutbox"] = None
        self.assertEqual(controller.load_command_outbox(), newer)


if __name__ == "__main__":
    unittest.main()
