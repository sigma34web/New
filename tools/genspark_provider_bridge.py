#!/usr/bin/env python3
"""
Genspark Provider Bridge Service for Yeonjae Studio.

Exposes a local HTTP server speaking the /v1/complete protocol expected by
@yeonjae/gateway HttpProvider, backed by genspark_auth.py with curl_cffi Chrome
TLS impersonation and cookie rotation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import signal
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

# Locate and import genspark_auth
GENSPARK_AUTH_DIRS = [
    "/home/ubuntu/nvidia_chat_bot",
    "/home/ubuntu/NovelForge-EN/backend/app/services/ai/providers",
    os.path.dirname(os.path.abspath(__file__)),
]

genspark_auth = None
for d in GENSPARK_AUTH_DIRS:
    if os.path.isdir(d) and d not in sys.path:
        sys.path.insert(0, d)
    try:
        import genspark_auth as _g_auth  # type: ignore
        genspark_auth = _g_auth
        break
    except ImportError:
        continue

if genspark_auth is None:
    raise RuntimeError(f"Could not import genspark_auth from any of: {GENSPARK_AUTH_DIRS}")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [genspark-bridge] %(message)s",
)
logger = logging.getLogger("genspark_bridge")

_in_flight_locks: Dict[str, threading.Event] = {}
_in_flight_mutex = threading.Lock()
DEFAULT_MODEL = os.getenv("YEONJAE_GENSPARK_MODEL", "gemini-3.8-flash")


def _sha256(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()[:16]


_FENCE_RX = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def _extract_json(text: str) -> Optional[Any]:
    raw = (text or "").strip()
    if not raw:
        return None
    candidates = [raw]
    for m in _FENCE_RX.findall(raw):
        candidates.append(m.strip())
    first_brace = raw.find("{")
    last_brace = raw.rfind("}")
    if first_brace >= 0 and last_brace > first_brace:
        candidates.append(raw[first_brace:last_brace + 1])
    for c in candidates:
        try:
            return json.loads(c)
        except Exception:
            pass
    return None


class GensparkBridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress default noisy access logs; handled in handlers
        pass

    def _send_json(self, status: int, data: Any) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/health":
            pool = genspark_auth.get_account_pool()
            accs = pool.list_accounts()
            active = pool.get_active_account()
            self._send_json(200, {
                "status": "ok",
                "provider": "genspark",
                "active_account": active.name if active else None,
                "accounts_count": len(accs),
                "accounts": accs,
                "default_model": DEFAULT_MODEL,
                "models": genspark_auth.GENSPARK_PRESET_MODELS,
            })
            return

        if path == "/v1/models":
            models = [
                {"id": m, "name": m, "provider": "genspark"}
                for m in genspark_auth.GENSPARK_PRESET_MODELS
            ]
            self._send_json(200, {"models": models})
            return

        self._send_json(404, {"error": "not_found", "path": path})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length).decode("utf-8", errors="replace")

        try:
            payload = json.loads(raw_body) if raw_body else {}
        except Exception as exc:
            self._send_json(400, {"error": "bad_request", "detail": f"Malformed JSON: {exc}"})
            return

        if path == "/v1/cancel":
            key = str(payload.get("idempotencyKey") or "")
            with _in_flight_mutex:
                event = _in_flight_locks.get(key)
                if event:
                    event.set()
            logger.info("Cancellation requested for idempotencyKey: %s", key or "<none>")
            self._send_json(200, {"remote_cancellation": "acknowledged", "idempotencyKey": key})
            return

        if path == "/v1/complete":
            self._handle_complete(payload)
            return

        self._send_json(404, {"error": "not_found", "path": path})

    def _handle_complete(self, payload: Dict[str, Any]) -> None:
        model_id = str(payload.get("modelId") or DEFAULT_MODEL)
        system = str(payload.get("system") or "").strip()
        user = str(payload.get("user") or "").strip()
        params = payload.get("params") or {}
        idempotency_key = str(payload.get("idempotencyKey") or uuid.uuid4().hex[:16])

        cancel_event = threading.Event()
        with _in_flight_mutex:
            _in_flight_locks[idempotency_key] = cancel_event

        temperature = float(params.get("temperature", 0.3))
        max_tokens = int(params.get("max_tokens", 8192))
        json_mode = bool(params.get("json_schema_mode", False))

        messages: List[Dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user})

        prompt_hash = _sha256(system + "\x1f" + user)
        logger.info(
            "Complete request: model=%s, temp=%.2f, max_tokens=%d, prompt_hash=%s, idemp=%s",
            model_id, temperature, max_tokens, prompt_hash, idempotency_key
        )

        started = time.time()
        try:
            result = genspark_auth.send_chat_completion(
                messages=messages,
                model=model_id,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
                log_stream=False,
            )
        except genspark_auth.GensparkRateLimitError as rle:
            logger.warning("Genspark rate limit on complete: %s", rle)
            self._send_json(429, {
                "error": "rate_limited",
                "message": str(rle),
            })
            return
        except Exception as exc:
            err_msg = str(exc)
            logger.error("Genspark completion error: %s", err_msg)
            status_code = 502
            if "401" in err_msg or "unauthorized" in err_msg.lower():
                status_code = 401
            elif "429" in err_msg or "rate limit" in err_msg.lower():
                status_code = 429
            self._send_json(status_code, {
                "error": "provider_error",
                "message": err_msg[:300],
            })
            return
        finally:
            with _in_flight_mutex:
                _in_flight_locks.pop(idempotency_key, None)

        if cancel_event.is_set():
            logger.info("Request %s completed after cancellation; returning cancelled status", idempotency_key)
            self._send_json(499, {"error": "client_closed_request", "message": "Request cancelled"})
            return

        text = result.get("content") or ""
        finish_reason = result.get("finish_reason") or "stop"
        usage_data = result.get("usage") or {}
        input_tokens = int(usage_data.get("prompt_tokens") or max(1, len(system + user) // 4))
        output_tokens = int(usage_data.get("completion_tokens") or max(1, len(text) // 4))

        parsed_json = None
        if json_mode or params.get("json_schema_mode"):
            parsed_json = _extract_json(text)

        elapsed = time.time() - started
        logger.info(
            "Complete success in %.2fs: output_chars=%d, in_tokens=%d, out_tokens=%d",
            elapsed, len(text), input_tokens, output_tokens
        )

        resp_body = {
            "modelId": model_id,
            "provider": "genspark",
            "providerRequestId": f"genspark-{idempotency_key}",
            "text": text,
            "finishReason": finish_reason if finish_reason in ("stop", "length", "content_filter", "error") else "stop",
            "usage": {
                "input": input_tokens,
                "output": output_tokens,
                "cached": 0,
            },
        }
        if parsed_json is not None:
            resp_body["json"] = parsed_json

        self._send_json(200, resp_body)


def run_server(host: str = "127.0.0.1", port: int = 8091) -> None:
    server = ThreadingHTTPServer((host, port), GensparkBridgeHandler)
    logger.info("Genspark Provider Bridge listening on http://%s:%d", host, port)
    logger.info("Health check: http://%s:%d/health", host, port)
    logger.info("Complete endpoint: http://%s:%d/v1/complete", host, port)

    def _shutdown(signum: int, frame: Any) -> None:
        logger.info("Shutting down Genspark Provider Bridge...")
        threading.Thread(target=server.shutdown).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        server.serve_forever()
    except Exception as exc:
        logger.info("Server terminated: %s", exc)
    finally:
        server.server_close()
        logger.info("Server stopped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Genspark Provider Bridge for Yeonjae Studio")
    parser.add_argument(
        "--host",
        type=str,
        default=os.getenv("YEONJAE_GENSPARK_HOST", "127.0.0.1"),
        help="Host interface to bind (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("YEONJAE_GENSPARK_PORT", "8091")),
        help="Port to listen on (default: 8091)",
    )
    args = parser.parse_args()
    run_server(host=args.host, port=args.port)
