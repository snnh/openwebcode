#!/usr/bin/env python3
"""Landlock backend end-to-end tests (explicit sandbox.mode "landlock").

Everything here needs Linux with a usable Landlock ABI; anywhere else
(including kernels without Landlock) the suite skips from the configure
reply, which reports the real probe result.  The default backend is
bubblewrap where available, so these cases pin mode "landlock" to keep
exercising the fallback backend.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile


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


def configure(proc, request_id, cwd, sandbox):
    request(proc, request_id, "session.configure", {"sessionId": "ll", "cwd": cwd, "sandbox": sandbox})
    return collect_until_response(proc, request_id)[0]


def run_exec(proc, request_id, cwd, cmd):
    request(proc, request_id, "exec.run", {
        "sessionId": "ll",
        "execId": f"exec-{request_id}",
        "cmd": cmd,
        "cwd": cwd,
        "timeoutMs": 15000,
    })
    response, notifications = collect_until_response(proc, request_id)
    assert "result" in response, response
    output = "".join(
        base64.b64decode(note["params"]["data"]).decode("utf-8", "replace")
        for note in notifications
        if note.get("method") == "exec.output"
    )
    return response["result"], output


def main():
    executable = sys.argv[1]
    if not sys.platform.startswith("linux"):
        print("SKIP: Landlock e2e requires Linux", file=sys.stderr)
        print("test_landlock_e2e.py: ok")
        return
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    workspace = tempfile.mkdtemp(prefix="owc-ll-workspace-")
    outside = tempfile.mkdtemp(prefix="owc-ll-outside-", dir=os.path.expanduser("~"))
    try:
        response = configure(proc, 1, workspace, {"enabled": True, "network": "allow", "mode": "landlock"})
        assert "result" in response, response
        capability = response["result"]["sandboxCapability"]
        if capability == "advisory":
            print(f"SKIP: Landlock unavailable ({response['result'].get('sandboxReason', '')})", file=sys.stderr)
            print("test_landlock_e2e.py: ok")
            return

        # A file outside the session roots (and outside the runtime exemption
        # table, hence $HOME rather than /tmp) is unreadable: EACCES.
        outside_file = os.path.join(outside, "outside.txt")
        with open(outside_file, "w", encoding="utf-8") as stored:
            stored.write("outside-content")
        result, output = run_exec(proc, 2, workspace, f"cat '{outside_file}'")
        assert result["exitCode"] != 0, result
        assert "Permission denied" in output, output

        # Disabled-sandbox control: the same read succeeds.
        response = configure(proc, 3, workspace, {"enabled": False})
        assert "result" in response, response
        result, output = run_exec(proc, 4, workspace, f"cat '{outside_file}'")
        assert result["exitCode"] == 0, result
        assert "outside-content" in output, output

        # Session write roots beyond the cwd are writable by the child.
        response = configure(proc, 5, workspace, {
            "enabled": True, "network": "allow", "mode": "landlock",
            "readRoots": [workspace], "writeRoots": [workspace, outside],
        })
        assert "result" in response, response
        extra_write = os.path.join(outside, "extra-write-root.txt")
        result, _ = run_exec(proc, 6, workspace, f"printf write-root-ok > '{extra_write}'")
        assert result["exitCode"] == 0, result
        with open(extra_write, "r", encoding="utf-8") as stored:
            assert stored.read() == "write-root-ok"

        # Network denial needs Landlock ABI 4; the configure reply reports
        # partial with the ABI caveat below that.
        response = configure(proc, 7, workspace, {"enabled": True, "network": "deny", "mode": "landlock"})
        assert "result" in response, response
        if response["result"]["sandboxCapability"] != "enforced":
            print(f"SKIP: network denial needs Landlock ABI 4 ({response['result'].get('sandboxReason', '')})",
                  file=sys.stderr)
        elif shutil.which("python3"):
            probe = ("python3 -c \"import socket; s = socket.socket(); "
                     "s.settimeout(2); s.connect(('127.0.0.1', 9))\"")
            result, output = run_exec(proc, 8, workspace, probe)
            assert result["exitCode"] != 0, result
            assert "Permission denied" in output, output
        else:
            print("SKIP: python3 not on PATH; network case not run", file=sys.stderr)
        print("test_landlock_e2e.py: ok")
    finally:
        try:
            request(proc, 99, "core.shutdown")
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(workspace, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


if __name__ == "__main__":
    main()
