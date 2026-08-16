import json
import socket
import unittest
from pathlib import Path
from unittest import mock

import health_check
import controller
import agent


class HealthCheckTests(unittest.TestCase):
    def test_configuration_requires_the_public_spotify_contract(self):
        self.assertEqual(
            health_check.configuration_check(lambda _url: {
                "spotifyClientId": "public-client-id",
                "spotifyRedirectUri": "https://poc.test/spotify/callback",
            }),
            {"status": "healthy", "reasonCode": "configuration_valid"},
        )
        self.assertEqual(
            health_check.configuration_check(lambda _url: {"spotifyClientId": ""}),
            {"status": "unavailable", "reasonCode": "configuration_invalid"},
        )

    def test_controller_states_keep_unknown_and_safe_readiness_categories(self):
        components = health_check.controller_checks(lambda _url: {
            "gameApi": {"status": "healthy", "reasonCode": "authenticated_poll_succeeded"},
            "browserReadiness": {
                "spotifyAuthorization": {"status": "unknown", "reasonCode": "browser_report_stale"},
                "player": {"status": "degraded", "reasonCode": "player_not_ready"},
            },
        })
        self.assertEqual(components["gameApi"]["status"], "healthy")
        self.assertEqual(components["spotifyAuthorization"]["status"], "unknown")
        self.assertEqual(components["player"]["status"], "degraded")
        self.assertNotIn("lease", json.dumps(components))

    def test_controller_rejects_unrecognized_state_instead_of_claiming_health(self):
        components = health_check.controller_checks(lambda _url: {
            "gameApi": {"status": "perfect", "reasonCode": "raw private failure"},
            "browserReadiness": {},
        })
        self.assertEqual(components["gameApi"], {
            "status": "unknown", "reasonCode": "controller_contract_invalid",
        })
        self.assertNotIn("raw private failure", json.dumps(components))

    def test_endpoint_timeout_is_bounded_and_does_not_leak_the_exception(self):
        with mock.patch.object(
            health_check.urllib.request,
            "urlopen",
            side_effect=socket.timeout("private endpoint detail"),
        ) as urlopen:
            result = health_check.fetch_json("http://127.0.0.1:4781/config")
        self.assertEqual(result, {"status": "unavailable", "reasonCode": "timeout"})
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 3)
        self.assertNotIn("private endpoint detail", json.dumps(result))

    def test_unavailable_capacity_is_unknown_instead_of_aborting_the_report(self):
        disk = health_check.disk_check(lambda _path: (_ for _ in ()).throw(OSError("private disk")))
        memory = health_check.memory_check(lambda: (_ for _ in ()).throw(OSError("private memory")))
        self.assertEqual(disk, {"status": "unknown", "reasonCode": "capacity_unavailable"})
        self.assertEqual(memory, {"status": "unknown", "reasonCode": "capacity_unavailable"})
        self.assertNotIn("private", json.dumps({"disk": disk, "memory": memory}))

    def test_failed_relay_and_unknown_readiness_affect_the_source_summary(self):
        healthy = {"status": "healthy", "reasonCode": "test"}
        checks = {
            "services": {name: "active" for name in health_check.CORE_SERVICES},
            "configuration": healthy,
            "gameApi": healthy,
            "spotifyAuthorization": healthy,
            "player": healthy,
            "disk": healthy,
            "memory": healthy,
            "relayPublisher": {"status": "unavailable", "reasonCode": "service_failure"},
        }
        self.assertEqual(health_check.overall_status(checks), "unavailable")
        checks["relayPublisher"] = {"status": "idle", "reasonCode": "no_active_lease"}
        checks["player"] = {"status": "unknown", "reasonCode": "browser_report_stale"}
        self.assertEqual(health_check.overall_status(checks), "degraded")


class ProvisioningContractTests(unittest.TestCase):
    def test_vnc_is_not_enabled_until_its_password_file_is_installed(self):
        root = Path(__file__).resolve().parent
        installer = (root / "infra" / "install-runtime.sh").read_text(encoding="utf-8")
        password_installer = root / "infra" / "install-vnc-password.sh"
        self.assertTrue(password_installer.is_file())
        self.assertIn("vnc.pass", password_installer.read_text(encoding="utf-8"))
        enable_block = installer.split("systemctl enable --now \\\n", 1)[-1].split("\n\n", 1)[0]
        self.assertNotIn("cannabeats-vnc.service", enable_block)
        self.assertIn("source-ui/protocol.mjs", installer)
        self.assertIn("source_reporter.py", installer)
        self.assertIn("groupadd --system cannabeats-diagnostics", installer)
        self.assertIn(
            "usermod --append --groups cannabeats-diagnostics cannabeats-controller",
            installer,
        )
        self.assertNotIn(
            "usermod --append --groups cannabeats-audio cannabeats-controller", installer,
        )
        infra = Path(__file__).with_name("infra")
        controller_unit = (infra / "cannabeats-source-controller.service").read_text()
        relay_unit = (infra / "cannabeats-relay-push.service").read_text()
        self.assertIn("SupplementaryGroups=cannabeats-diagnostics", controller_unit)
        self.assertNotIn("SupplementaryGroups=cannabeats-audio", controller_unit)
        self.assertIn("CANNABEATS_PUBLISHER_DIAGNOSTICS_SOCKET=", controller_unit)
        self.assertIn("Group=cannabeats-diagnostics", relay_unit)
        self.assertIn("SupplementaryGroups=cannabeats-audio", relay_unit)
        self.assertIn("--diagnostics-socket /run/cannabeats-diagnostics/", relay_unit)
        tmpfiles = (infra / "cannabeats-diagnostics.conf").read_text()
        self.assertEqual(
            tmpfiles.strip(),
            "d /run/cannabeats-diagnostics 0750 cannabeats-relay cannabeats-diagnostics -",
        )
        sibling_pin = (
            root.parent / "access-spotify-poc" / "deploy" / "btaudio-runtime.version"
        ).read_text(encoding="utf-8").strip()
        self.assertEqual(
            sibling_pin,
            "4cbdd31d8a7fa53eb3874f3554b0d6c9411689e7",
        )


class ControllerReadinessTests(unittest.TestCase):
    def setUp(self):
        self.original = dict(controller.state)

    def tearDown(self):
        with controller.lock:
            controller.state.clear()
            controller.state.update(self.original)

    def test_public_state_reports_authenticated_poll_and_browser_readiness(self):
        with mock.patch.object(controller.time, "monotonic", return_value=100.0):
            with controller.lock:
                controller.state["lastError"] = None
                controller.state["lastSuccessfulPoll"] = 99.0
            controller.record_browser_readiness({
                "spotifyAuthorization": "authorized",
                "player": "ready",
                "playbackObservation": "playing",
                "playbackObservationAgeMs": 0,
            })
            public = controller.public_state()
        self.assertEqual(public["gameApi"], {
            "status": "healthy", "reasonCode": "authenticated_poll_succeeded",
        })
        self.assertEqual(public["browserReadiness"]["spotifyAuthorization"]["status"], "healthy")
        self.assertEqual(public["browserReadiness"]["player"]["status"], "healthy")
        self.assertNotIn("lastSuccessfulPoll", public)

    def test_stale_browser_report_is_unknown_and_payload_values_are_allowlisted(self):
        with mock.patch.object(controller.time, "monotonic", side_effect=[10.0, 40.0]):
            controller.record_browser_readiness({
                "spotifyAuthorization": "not_authorized",
                "player": "not_ready",
                "playbackObservation": "unknown",
                "playbackObservationAgeMs": None,
            })
            public = controller.public_state()
        self.assertEqual(public["browserReadiness"]["spotifyAuthorization"], {
            "status": "unknown", "reasonCode": "browser_report_stale",
        })
        with self.assertRaises(ValueError):
            controller.record_browser_readiness({
                "spotifyAuthorization": "raw private provider error",
                "player": "ready",
                "playbackObservation": "unknown",
                "playbackObservationAgeMs": None,
            })


class AgentTransitionTests(unittest.TestCase):
    def test_repeated_configuration_failures_log_once_and_recovery_logs_once(self):
        records = []
        with mock.patch.object(agent, "operational_log", side_effect=lambda *args, **kwargs: records.append((args, kwargs))):
            agent.configuration_transition(False, "TimeoutError")
            agent.configuration_transition(False, "TimeoutError")
            agent.configuration_transition(True)
            agent.configuration_transition(True)
        self.assertEqual([entry[0][1] for entry in records], [
            "configuration.unavailable", "configuration.recovered",
        ])


if __name__ == "__main__":
    unittest.main()
