#!/usr/bin/env python3
"""Universal Anamnesis HTTP shim for Claude Code hooks.

Reads hook JSON from stdin, POSTs to the Anamnesis HTTP server,
and prints the response JSON to stdout.

Usage (in settings.json):
  "command": "python D:/Projects/Anamnesis/hooks/anamnesis-shim.py /hooks/session-start"

The server is auto-started if not running (on SessionStart).
Graceful degradation: if server is unreachable, exits 0 (doesn't block Claude Code).
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

SERVER_URL = os.environ.get("ANAMNESIS_SERVER_URL", "http://127.0.0.1:3851")
ANAMNESIS_DIR = os.environ.get("ANAMNESIS_DIR", "D:/Projects/Anamnesis")
STARTUP_TIMEOUT = 8  # seconds to wait for server to start


def log(msg: str):
    sys.stderr.write(f"anamnesis-shim: {msg}\n")


def server_healthy() -> bool:
    """Check if the Anamnesis server is responding."""
    try:
        req = urllib.request.Request(f"{SERVER_URL}/health")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def start_server():
    """Start the Anamnesis HTTP server as a detached process."""
    server_js = os.path.join(ANAMNESIS_DIR, "dist", "server.js")
    if not os.path.isfile(server_js):
        log(f"server.js not found at {server_js}")
        return False

    try:
        kwargs = {
            "stdout": subprocess.DEVNULL,
            "stderr": open(os.path.join(ANAMNESIS_DIR, "server.log"), "a"),
        }
        if os.name == "nt":
            kwargs["creationflags"] = (
                subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
            )
        else:
            kwargs["start_new_session"] = True

        subprocess.Popen(["node", server_js], **kwargs)
        log("Started Anamnesis server")

        # Wait for it to come up
        import time
        for _ in range(STARTUP_TIMEOUT):
            time.sleep(1)
            if server_healthy():
                return True
        log("Server started but not responding after timeout")
        return False
    except Exception as e:
        log(f"Failed to start server: {e}")
        return False


def post(endpoint: str, data: dict) -> dict | None:
    """POST JSON to the server and return parsed response."""
    try:
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(
            f"{SERVER_URL}{endpoint}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        log(f"POST {endpoint} failed: {e}")
        return None


def main():
    if len(sys.argv) < 2:
        log("Usage: anamnesis-shim.py <endpoint>")
        sys.exit(0)

    endpoint = sys.argv[1]

    # Read hook input from stdin
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        hook_input = {}

    # For session-start, auto-start server if needed
    if endpoint == "/hooks/session-start":
        if not server_healthy():
            if not start_server():
                sys.exit(0)

    # For other hooks, just check health and bail if down
    elif not server_healthy():
        sys.exit(0)

    # POST to server
    result = post(endpoint, hook_input)

    if result:
        print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    main()
