"""
Trust-aware agentic router — stdlib HTTP API.

Run:
    python server.py            # listens on 127.0.0.1:8787
    PORT=9000 python server.py

Endpoints (all JSON):
    GET  /health                       -> {"ok": true}
    GET  /agents                       -> registered identities
    POST /agents      {AgentIdentity}  -> 201 + stored record | 400 TrustContractError
    POST /beliefs     {BeliefEnvelope} -> 200 + governed (clamped) belief | 400
    POST /route       {domain, candidates?} -> ranked routing decisions | 400

The server is a thin transport over trust_router; all trust enforcement lives
in the core so it is testable without a socket (see test_trust_router.py).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from trust_router import (
    BeliefRejected,
    RoutingError,
    TrustContractError,
    TrustRouter,
    default_registry,
)

ROUTER = TrustRouter(default_registry())


class Handler(BaseHTTPRequestHandler):
    server_version = "TrustRouter/0.1"

    # ── helpers ────────────────────────────────────────────────────────────────
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, path: str) -> None:
        try:
            with open(path, "rb") as fh:
                body = fh.read()
        except OSError:
            return self._send(404, {"error": "console_not_found"})
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def log_message(self, *args):  # quiet by default
        pass

    # ── routes ───────────────────────────────────────────────────────────────────
    def do_GET(self):
        if self.path in ("/", "/index.html", "/console"):
            here = os.path.dirname(os.path.abspath(__file__))
            return self._send_html(os.path.join(here, "console.html"))
        if self.path == "/health":
            return self._send(200, {"ok": True})
        if self.path == "/agents":
            return self._send(200, {"agents": ROUTER.registry.all()})
        return self._send(404, {"error": "not_found", "path": self.path})

    def do_POST(self):
        try:
            body = self._read_json()
        except json.JSONDecodeError as err:
            return self._send(400, {"error": "invalid_json", "detail": str(err)})

        try:
            if self.path == "/agents":
                record = ROUTER.registry.register(body)
                return self._send(201, {"registered": record})
            if self.path == "/beliefs":
                return self._send(200, {"belief": ROUTER.admit(body)})
            if self.path == "/route":
                domain = body.get("domain", "")
                candidates = body.get("candidates")
                # Per-request policy override so the console's strict toggle is
                # enforced server-side, not faked in the browser.
                router = ROUTER
                if "require_domain_authority" in body:
                    router = TrustRouter(
                        ROUTER.registry,
                        {"require_domain_authority": bool(body["require_domain_authority"])},
                    )
                decisions = router.route(domain, candidates)
                return self._send(200, {"decisions": [asdict(d) for d in decisions]})
            return self._send(404, {"error": "not_found", "path": self.path})
        except (TrustContractError, BeliefRejected, RoutingError) as err:
            return self._send(400, {"error": type(err).__name__, "detail": str(err)})


def main() -> None:
    port = int(os.environ.get("PORT", "8787"))
    host = os.environ.get("HOST", "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"trust-router listening on http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
