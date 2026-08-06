#!/usr/bin/env python3
"""bubblewrap (bwrap) sandbox backend protocol tests.

Shape/validation cases run everywhere: core.ping advertises features.bwrap
on every platform, and the POSIX-only mode values must be rejected on
Windows.  The end-to-end cases need Linux with a working bwrap (user
namespaces permitted); anywhere else they are skipped, which includes
Windows, macOS, and CI containers without unprivileged userns.
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


def configure(proc, request_id, cwd, sandbox=None):
    params = {"sessionId": "bwrap", "cwd": cwd}
    if sandbox is not None:
        params["sandbox"] = sandbox
    request(proc, request_id, "session.configure", params)
    return collect_until_response(proc, request_id)[0]


def assert_error(response, code, needle=None):
    error = response.get("error")
    assert error is not None, response
    assert error["code"] == code, response
    if needle:
        assert needle in error["message"], response


def run_exec(proc, request_id, cwd, cmd, exec_id=None):
    request(proc, request_id, "exec.run", {
        "sessionId": "bwrap",
        "execId": exec_id or f"exec-{request_id}",
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
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        request(proc, 1, "core.ping")
        response, _ = collect_until_response(proc, 1)
        assert "result" in response, response
        bwrap = response["result"]["features"].get("bwrap")
        assert isinstance(bwrap, dict), response["result"]["features"]
        assert set(bwrap) == {"available", "reason"}, bwrap
        assert isinstance(bwrap["available"], bool), bwrap
        assert isinstance(bwrap["reason"], str) and bwrap["reason"], bwrap

        workspace = tempfile.mkdtemp(prefix="owc-bwrap-workspace-")
        try:
            if os.name == "nt":
                # The POSIX-only mode values are rejected on Windows builds.
                assert bwrap["available"] is False, bwrap
                assert "only available on Linux" in bwrap["reason"], bwrap
                response = configure(proc, 2, workspace, {"enabled": True, "mode": "landlock"})
                assert_error(response, -32602, "landlock")
                response = configure(proc, 3, workspace, {"enabled": True, "mode": "bubblewrap"})
                assert_error(response, -32602, "bubblewrap")
            else:
                # POSIX accepts both mode values.
                response = configure(proc, 2, workspace, {"enabled": True, "mode": "landlock"})
                assert "result" in response, response
                response = configure(proc, 3, workspace, {"enabled": True, "mode": "bubblewrap"})
                assert "result" in response, response

            if not sys.platform.startswith("linux") or not bwrap["available"]:
                print(f"SKIP: bwrap e2e needs Linux with a usable bwrap ({bwrap})", file=sys.stderr)
            else:
                run_bwrap_e2e(proc, workspace)
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
        print("test_bwrap.py: ok")
    finally:
        try:
            request(proc, 99, "core.shutdown")
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


def run_bwrap_e2e(proc, workspace):
    outside = tempfile.mkdtemp(prefix="owc-bwrap-outside-", dir=os.path.expanduser("~"))
    try:
        # Default backend: no mode key, so the session runs under bubblewrap.
        response = configure(proc, 10, workspace, {"enabled": True, "network": "allow"})
        assert "result" in response, response
        assert "bubblewrap" in response["result"]["sandboxReason"], response

        # Write boundary: the workspace is writable, an independent directory
        # under $HOME is not even mounted.
        inside_path = os.path.join(workspace, "workspace-write.txt")
        outside_path = os.path.join(outside, "outside-write.txt")
        result, _ = run_exec(
            proc, 11, workspace,
            f"printf workspace-ok > '{inside_path}'; printf outside-must-fail > '{outside_path}'",
        )
        assert result["sandboxCapability"] == "enforced", result
        assert result["exitCode"] != 0, result
        with open(inside_path, "r", encoding="utf-8") as stored:
            assert stored.read() == "workspace-ok"
        assert not os.path.exists(outside_path), outside_path

        # denyPaths masking: a denied file is shadowed by /dev/null (its
        # content is unreadable), a denied directory by an empty tmpfs.
        masked_file = os.path.join(workspace, "secret.txt")
        masked_dir = os.path.join(workspace, "secret-dir")
        os.mkdir(masked_dir)
        with open(masked_file, "w", encoding="utf-8") as stored:
            stored.write("top-secret")
        with open(os.path.join(masked_dir, "inner.txt"), "w", encoding="utf-8") as stored:
            stored.write("inner-secret")
        response = configure(proc, 12, workspace, {
            "enabled": True, "network": "allow",
            "denyPaths": [masked_file, masked_dir],
        })
        assert "result" in response, response
        result, output = run_exec(proc, 13, workspace, f"cat '{masked_file}'")
        assert "top-secret" not in output, output
        result, output = run_exec(proc, 14, workspace, f"cat '{masked_dir}/inner.txt'")
        assert result["exitCode"] != 0, result
        assert "inner-secret" not in output, output
        # Outside the sandbox the real content is untouched.
        with open(masked_file, "r", encoding="utf-8") as stored:
            assert stored.read() == "top-secret"

        # Network denial: bwrap brings the new namespace loopback up, so a
        # 127.0.0.1 connect fails with ECONNREFUSED either way, and some
        # kernels do not netns-filter /sys/class/net.  The reliable
        # discriminator is a non-loopback connect: inside the isolated
        # namespace there is no route at all (ENETUNREACH), outside it the
        # connect times out or is refused instead.
        if shutil.which("python3"):
            probe = ("python3 -c \"import socket; s = socket.socket(); "
                     "s.settimeout(2); s.connect(('192.0.2.1', 9))\"")
            response = configure(proc, 15, workspace, {"enabled": True, "network": "deny"})
            assert "result" in response, response
            result, output = run_exec(proc, 16, workspace, probe)
            assert result["exitCode"] != 0, result
            assert "Network is unreachable" in output, output
            response = configure(proc, 17, workspace, {"enabled": True, "network": "allow"})
            assert "result" in response, response
            result, output = run_exec(proc, 18, workspace, probe)
            assert result["exitCode"] != 0, result
            assert "Network is unreachable" not in output, output
        else:
            print("SKIP: python3 not on PATH; network case not run", file=sys.stderr)

        # readRoots are read-only: readable but not writable.
        read_only = tempfile.mkdtemp(prefix="owc-bwrap-readonly-")
        try:
            ro_file = os.path.join(read_only, "readable.txt")
            with open(ro_file, "w", encoding="utf-8") as stored:
                stored.write("read-only-ok")
            response = configure(proc, 24, workspace, {
                "enabled": True, "network": "allow",
                "readRoots": [workspace, read_only], "writeRoots": [workspace],
            })
            assert "result" in response, response
            result, output = run_exec(proc, 25, workspace, f"cat '{ro_file}'")
            assert result["exitCode"] == 0, result
            assert "read-only-ok" in output, output
            result, _ = run_exec(proc, 26, workspace, f"printf must-fail > '{read_only}/nope.txt'")
            assert result["exitCode"] != 0, result
            assert not os.path.exists(os.path.join(read_only, "nope.txt"))
        finally:
            shutil.rmtree(read_only, ignore_errors=True)

        # Explicit landlock mode runs the Landlock backend instead.
        response = configure(proc, 27, workspace, {"enabled": True, "network": "allow", "mode": "landlock"})
        assert "result" in response, response
        assert "Landlock" in response["result"]["sandboxReason"], response
        result, output = run_exec(proc, 28, workspace, "printf landlock-ok")
        assert result["exitCode"] == 0, result
        assert "landlock-ok" in output, output
    finally:
        shutil.rmtree(outside, ignore_errors=True)


if __name__ == "__main__":
    main()
