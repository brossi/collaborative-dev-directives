import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

import agent


class ManagedSourceAgentTest(unittest.TestCase):
    def test_protocol_module_is_served_from_the_source_ui(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), agent.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/protocol.mjs",
                timeout=2,
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    response.read(),
                    (agent.STATIC_DIRECTORY / "protocol.mjs").read_bytes(),
                )
                self.assertIn("javascript", response.headers["Content-Type"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
