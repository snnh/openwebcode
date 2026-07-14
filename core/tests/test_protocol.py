#!/usr/bin/env python3
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


def main():
    executable = sys.argv[1]
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        request(proc, "ping-中文", "core.ping")
        response, notes = collect_until_response(proc, "ping-中文")
        assert not notes
        assert response["result"]["version"] == "0.1.0"
        assert response["result"]["sandboxCapability"] == "advisory"

        request(proc, None, "core.ping")
        response, notes = collect_until_response(proc, None)
        assert not notes
        assert response["id"] is None
        assert response["result"]["version"] == "0.1.0"

        send(proc, {"jsonrpc": "2.0", "method": "core.ping", "params": {}})
        request(proc, "after-notification", "core.ping")
        response, notes = collect_until_response(proc, "after-notification")
        assert not notes
        assert response["result"]["version"] == "0.1.0"

        request(proc, 2, "missing.method")
        response, _ = collect_until_response(proc, 2)
        assert response["error"]["code"] == -32601

        if os.name == "nt":
            command = "echo hello&& echo error 1>&2&& exit /b 7"
            slow = "ping -n 6 127.0.0.1 >nul"
        else:
            command = "printf hello; printf error >&2; exit 7"
            slow = "sleep 5"

        request(proc, 3, "exec.run", {"sessionId": "s1", "execId": "e1", "cmd": command, "cwd": os.getcwd(), "timeoutMs": 5000})
        response, notes = collect_until_response(proc, 3)
        assert response["result"]["exitCode"] == 7
        assert [n["params"]["seq"] for n in notes] == list(range(len(notes)))
        output = b"".join(base64.b64decode(n["params"]["data"]) for n in notes)
        assert b"hello" in output and b"error" in output

        started = time.monotonic()
        request(proc, 4, "exec.run", {"sessionId": "s1", "execId": "e2", "cmd": slow, "cwd": os.getcwd(), "timeoutMs": 100})
        response, _ = collect_until_response(proc, 4)
        assert response["error"]["code"] == -32001
        assert time.monotonic() - started < 4

        request(proc, 5, "core.shutdown")
        response, _ = collect_until_response(proc, 5)
        assert response["result"]["ok"] is True
        assert proc.wait(timeout=5) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
        stderr = proc.stderr.read().decode(errors="replace")
        if stderr:
            print(stderr, file=sys.stderr)


if __name__ == "__main__":
    main()
