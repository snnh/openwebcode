#!/usr/bin/env python3
"""Protocol fixture for the pty.* RPC family (four methods + notifications).

Covers: capability/limits reporting, unknown-field rejection, parameter
validation, unknown-pty errors, and a real ConPTY/openpty smoke run
(open a shell, echo a marker through pty.input/pty.output, resize, exit,
close)."""
import base64
import json
import os
import subprocess
import sys
import time


def send(proc, message):
    body = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode()
    proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    proc.stdin.flush()


def receive(proc):
    headers = {}
    while True:
        line = proc.stdout.readline()
        if not line:
            raise AssertionError("owc-exec closed stdout")
        if line == b"\r\n":
            break
        name, value = line.decode("ascii").split(":", 1)
        headers[name.lower()] = value.strip()
    body = proc.stdout.read(int(headers["content-length"]))
    return json.loads(body)


def request(proc, request_id, method, params=None):
    send(proc, {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})


def collect_until_response(proc, request_id):
    notifications = []
    while True:
        message = receive(proc)
        if message.get("id") == request_id:
            return message, notifications
        notifications.append(message)


def wait_for_notification(proc, method, predicate, timeout=15.0):
    """Read messages until a matching notification arrives or the deadline passes."""
    deadline = time.monotonic() + timeout
    seen = []
    while time.monotonic() < deadline:
        message = receive(proc)
        if message.get("method") == method and predicate(message.get("params", {})):
            return message, seen
        seen.append(message)
    raise AssertionError(f"timed out waiting for {method}; saw {seen!r}")


def pty_input(proc, request_id, pty_id, text):
    request(proc, request_id, "pty.input", {"ptyId": pty_id, "data": base64.b64encode(text.encode()).decode("ascii")})
    response, _ = collect_until_response(proc, request_id)
    assert response.get("result", {}).get("ok") is True, response


def smoke_shell_roundtrip(proc, session_id, pty_id, marker):
    """Type a marker echo into the shell and require it back on pty.output."""
    newline = "\r\n" if os.name == "nt" else "\n"
    pty_input(proc, f"in-{marker}", pty_id, f"echo {marker}{newline}")
    collected = b""
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and marker.encode() not in collected:
        message, _ = wait_for_notification(proc, "pty.output", lambda p: p.get("ptyId") == pty_id, timeout=15)
        collected += base64.b64decode(message["params"]["data"])
    assert marker.encode() in collected, collected


def main():
    executable = sys.argv[1]
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    cwd = os.getcwd()
    try:
        request(proc, 1, "core.ping")
        response, _ = collect_until_response(proc, 1)
        result = response["result"]
        assert isinstance(result["features"].get("pty"), bool), result["features"]
        pty_supported = result["features"]["pty"]
        limits = result["limits"]
        assert limits["maxConcurrentPtys"] == 16, limits
        assert limits["maxPtyOutputChunkBytes"] == 64 * 1024, limits
        assert limits["maxPtyInputBytes"] == 8 * 1024, limits

        # Unknown fields are rejected on every pty method.
        request(proc, 2, "pty.open", {"session": "x", "cwd": cwd, "cols": 80, "rows": 24, "sandbox": False, "bogus": 1})
        response, _ = collect_until_response(proc, 2)
        assert response["error"]["code"] == -32602, response
        for bad_id, method, params in [
            (3, "pty.input", {"ptyId": 1, "data": "QUJD", "bogus": 1}),
            (4, "pty.resize", {"ptyId": 1, "cols": 80, "rows": 24, "bogus": 1}),
            (5, "pty.close", {"ptyId": 1, "bogus": 1}),
        ]:
            request(proc, bad_id, method, params)
            response, _ = collect_until_response(proc, bad_id)
            assert response["error"]["code"] == -32602, (method, response)

        # Session must be configured and cwd must match the session root.
        request(proc, 6, "pty.open", {"session": "unconfigured", "cwd": cwd, "cols": 80, "rows": 24, "sandbox": False})
        response, _ = collect_until_response(proc, 6)
        assert response["error"]["code"] == -32002, response

        request(proc, 7, "session.configure", {"sessionId": "pty", "cwd": cwd, "sandbox": {"enabled": False}})
        response, _ = collect_until_response(proc, 7)
        assert "result" in response, response

        # Parameter validation.
        for bad_id, params in [
            (10, {"session": "pty", "cwd": cwd, "rows": 24, "sandbox": False}),
            (11, {"session": "pty", "cwd": cwd, "cols": 0, "rows": 24, "sandbox": False}),
            (12, {"session": "pty", "cwd": cwd, "cols": 80, "rows": 513, "sandbox": False}),
            (13, {"session": "pty", "cwd": cwd, "cols": 80, "rows": 24}),
            (14, {"session": "pty", "cwd": cwd, "cols": 80, "rows": 24, "sandbox": "yes"}),
            (15, {"session": "pty", "cwd": cwd, "cols": 80, "rows": 24, "sandbox": False, "shell": ""}),
        ]:
            request(proc, bad_id, "pty.open", params)
            response, _ = collect_until_response(proc, bad_id)
            assert response["error"]["code"] == -32602, (params, response)

        # Unknown pty / malformed input.
        request(proc, 20, "pty.input", {"ptyId": 999, "data": "QUJD"})
        response, _ = collect_until_response(proc, 20)
        assert response["error"]["code"] == -32003, response
        request(proc, 21, "pty.input", {"ptyId": 1, "data": "A==="})
        response, _ = collect_until_response(proc, 21)
        assert response["error"]["code"] == -32602, response
        request(proc, 22, "pty.input", {"ptyId": 1, "data": base64.b64encode(b"x" * 8193).decode("ascii")})
        response, _ = collect_until_response(proc, 22)
        assert response["error"]["code"] == -32602, response
        request(proc, 23, "pty.resize", {"ptyId": 999, "cols": 80, "rows": 24})
        response, _ = collect_until_response(proc, 23)
        assert response["error"]["code"] == -32003, response
        request(proc, 24, "pty.resize", {"ptyId": 1, "cols": 0, "rows": 24})
        response, _ = collect_until_response(proc, 24)
        assert response["error"]["code"] == -32602, response
        request(proc, 25, "pty.close", {"ptyId": 999})
        response, _ = collect_until_response(proc, 25)
        assert response["error"]["code"] == -32003, response

        if not pty_supported:
            print("SKIP: pty is not supported on this platform", file=sys.stderr)
        else:
            # Real PTY smoke (Windows ConPTY / POSIX openpty): owner-identity
            # channel (sandbox=false) must report advisory honestly.
            request(proc, 30, "pty.open", {"session": "pty", "cwd": cwd, "cols": 80, "rows": 24, "sandbox": False})
            response, _ = collect_until_response(proc, 30)
            assert "result" in response, response
            pty_id = response["result"]["ptyId"]
            assert response["result"]["sandboxCapability"] == "advisory", response["result"]

            smoke_shell_roundtrip(proc, "pty", pty_id, "hi-pty-marker")

            request(proc, 31, "pty.resize", {"ptyId": pty_id, "cols": 100, "rows": 30})
            response, _ = collect_until_response(proc, 31)
            assert response.get("result", {}).get("ok") is True, response

            # Sandboxed channel: AppContainer x ConPTY may degrade to the Job
            # Object compatibility mode; the reply must report it honestly.
            request(proc, 32, "pty.open", {"session": "pty", "cwd": cwd, "cols": 80, "rows": 24, "sandbox": True})
            response, _ = collect_until_response(proc, 32)
            assert "result" in response, response
            sandboxed_id = response["result"]["ptyId"]
            capability = response["result"]["sandboxCapability"]
            assert capability in {"enforced", "partial", "advisory"}, response["result"]
            print(f"INFO: sandbox=true pty capability: {capability} ({response['result'].get('sandboxReason', '')})", file=sys.stderr)
            smoke_shell_roundtrip(proc, "pty", sandboxed_id, "hi-sandboxed-pty")
            request(proc, 33, "pty.close", {"ptyId": sandboxed_id})
            response, _ = collect_until_response(proc, 33)
            assert response.get("result", {}).get("ok") is True, response

            # Shell self-exit: pty.exit notification carries the exit code;
            # afterwards input fails and close reclaims the record.
            newline = "\r\n" if os.name == "nt" else "\n"
            pty_input(proc, 34, pty_id, f"exit{newline}")
            message, _ = wait_for_notification(proc, "pty.exit", lambda p: p.get("ptyId") == pty_id, timeout=15)
            assert message["params"]["exitCode"] == 0, message
            request(proc, 35, "pty.input", {"ptyId": pty_id, "data": base64.b64encode(b"x").decode("ascii")})
            response, _ = collect_until_response(proc, 35)
            assert response["error"]["code"] == -32000, response
            request(proc, 36, "pty.close", {"ptyId": pty_id})
            response, _ = collect_until_response(proc, 36)
            assert response.get("result", {}).get("ok") is True, response
            assert response["result"].get("exitCode") == 0, response
            request(proc, 37, "pty.close", {"ptyId": pty_id})
            response, _ = collect_until_response(proc, 37)
            assert response["error"]["code"] == -32003, response

        request(proc, 90, "core.shutdown")
        response, _ = collect_until_response(proc, 90)
        assert response["result"]["ok"] is True
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
        stderr = proc.stderr.read().decode(errors="replace")
        if stderr:
            print(stderr, file=sys.stderr)


if __name__ == "__main__":
    main()
