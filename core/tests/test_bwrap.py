#!/usr/bin/env python3
"""bubblewrap (bwrap) sandbox backend protocol tests.

Shape/validation cases run everywhere: core.ping advertises features.bwrap
on every platform, and the POSIX-only mode values must be rejected on
Windows.  The end-to-end cases need Linux with a working bwrap (user
namespaces permitted); anywhere else they are skipped, which includes
Windows, macOS, and CI containers without unprivileged userns.  The
fail-closed case (default tier without bwrap refuses to run commands)
needs no host bwrap: it spawns a core whose PATH hides bwrap.
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


def main_bwrap():
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
            if sys.platform.startswith("linux"):
                # Independent of the host bwrap availability: the probe
                # consults PATH, which this process strips to an empty dir.
                run_fail_closed_no_bwrap(executable)
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

        # A deny path that does not exist is skipped silently: the old
        # diagnostic ran after the child's dup2 and polluted the command's
        # stderr on every run (default deny paths like .env usually do not
        # exist yet), and the deny is vacuous for a path nothing can reach.
        response = configure(proc, 19, workspace, {
            "enabled": True, "network": "allow",
            "denyPaths": [os.path.join(workspace, "no-such-deny-path")],
        })
        assert "result" in response, response
        result, output = run_exec(proc, 20, workspace, "printf deny-skip-ok")
        assert result["exitCode"] == 0, result
        assert "deny-skip-ok" in output, output
        assert "bwrap deny path skipped" not in output, output

        # exec.run gives the command /dev/null as stdin: an interactive
        # reader like cat must see EOF immediately instead of racing the
        # main loop for the RPC pipe (leaking frames across sessions or
        # killing the loop with a partial frame).
        result, output = run_exec(proc, 21, workspace, "cat")
        assert result["exitCode"] == 0, result
        assert output == "", output
        # The RPC loop survived the cat: the next request round-trips.
        result, output = run_exec(proc, 22, workspace, "printf after-cat-ok")
        assert result["exitCode"] == 0, result
        assert "after-cat-ok" in output, output

        # Explicit landlock mode runs the Landlock backend instead.
        response = configure(proc, 27, workspace, {"enabled": True, "network": "allow", "mode": "landlock"})
        assert "result" in response, response
        assert "Landlock" in response["result"]["sandboxReason"], response
        result, output = run_exec(proc, 28, workspace, "printf landlock-ok")
        assert result["exitCode"] == 0, result
        assert "landlock-ok" in output, output
    finally:
        shutil.rmtree(outside, ignore_errors=True)


def run_fail_closed_no_bwrap(executable):
    """Default tier without a usable bwrap must fail closed: the command is
    refused (exit 126) with an actionable reason instead of silently running
    bare under a Landlock fallback that could not express denyPaths.  Works
    on any Linux host regardless of whether bwrap is installed: the probe
    consults PATH, which this process strips to an empty directory. """
    scratch = tempfile.mkdtemp(prefix="owc-nobwrap-workspace-")
    env = dict(os.environ)
    env["PATH"] = scratch
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=env)
    try:
        response = configure(proc, 1, scratch, {"enabled": True, "network": "allow"})
        assert "result" in response, response
        marker = os.path.join(scratch, "must-not-run.txt")
        result, output = run_exec(proc, 2, scratch, f"printf x > '{marker}'")
        assert result["exitCode"] == 126, result
        assert result["sandboxCapability"] == "advisory", result
        assert "bubblewrap unavailable" in result["sandboxReason"], result
        assert "landlock" in result["sandboxReason"], result
        assert not os.path.exists(marker), marker

        # The fail-closed gate only applies to enabled sessions: a disabled
        # sandbox still runs the command (and /bin/sh needs no PATH help).
        response = configure(proc, 3, scratch, {"enabled": False})
        assert "result" in response, response
        result, output = run_exec(proc, 4, scratch, "printf disabled-ok")
        assert result["exitCode"] == 0, result
        assert "disabled-ok" in output, output

        # The explicit landlock compatibility tier still runs without bwrap:
        # it either executes under an applied Landlock ruleset, or fails
        # closed (126) when Landlock itself is unavailable - never bare.
        response = configure(proc, 5, scratch, {"enabled": True, "network": "allow", "mode": "landlock"})
        assert "result" in response, response
        result, output = run_exec(proc, 6, scratch, "printf landlock-tier-ok")
        if result["sandboxCapability"] in ("enforced", "partial"):
            assert result["exitCode"] == 0, result
            assert "landlock-tier-ok" in output, output
        else:
            assert result["exitCode"] == 126, result
            assert result["sandboxCapability"] == "advisory", result
    finally:
        try:
            request(proc, 99, "core.shutdown")
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(scratch, ignore_errors=True)


# --- Landlock backend e2e (absorbed from test_landlock_e2e.py) ---
#
# Everything here needs Linux with a usable Landlock ABI; anywhere else
# (including kernels without Landlock) the suite skips from the configure
# reply, which reports the real probe result.  The default tier is
# bubblewrap only (no automatic Landlock fallback), so these cases pin
# mode "landlock" to exercise the explicit compatibility backend.


def configure_landlock(proc, request_id, cwd, sandbox):
    request(proc, request_id, "session.configure", {"sessionId": "ll", "cwd": cwd, "sandbox": sandbox})
    return collect_until_response(proc, request_id)[0]


def run_exec_landlock(proc, request_id, cwd, cmd):
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


def main_landlock_e2e():
    executable = sys.argv[1]
    if not sys.platform.startswith("linux"):
        print("SKIP: Landlock e2e requires Linux", file=sys.stderr)
        print("test_landlock_e2e.py: ok")
        return
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    workspace = tempfile.mkdtemp(prefix="owc-ll-workspace-")
    outside = tempfile.mkdtemp(prefix="owc-ll-outside-", dir=os.path.expanduser("~"))
    try:
        response = configure_landlock(proc, 1, workspace, {"enabled": True, "network": "allow", "mode": "landlock"})
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
        result, output = run_exec_landlock(proc, 2, workspace, f"cat '{outside_file}'")
        assert result["exitCode"] != 0, result
        assert "Permission denied" in output, output

        # Disabled-sandbox control: the same read succeeds.
        response = configure_landlock(proc, 3, workspace, {"enabled": False})
        assert "result" in response, response
        result, output = run_exec_landlock(proc, 4, workspace, f"cat '{outside_file}'")
        assert result["exitCode"] == 0, result
        assert "outside-content" in output, output

        # Session write roots beyond the cwd are writable by the child.
        response = configure_landlock(proc, 5, workspace, {
            "enabled": True, "network": "allow", "mode": "landlock",
            "readRoots": [workspace], "writeRoots": [workspace, outside],
        })
        assert "result" in response, response
        extra_write = os.path.join(outside, "extra-write-root.txt")
        result, _ = run_exec_landlock(proc, 6, workspace, f"printf write-root-ok > '{extra_write}'")
        assert result["exitCode"] == 0, result
        with open(extra_write, "r", encoding="utf-8") as stored:
            assert stored.read() == "write-root-ok"

        # Network denial needs Landlock ABI 4; the configure reply reports
        # partial with the ABI caveat below that.
        response = configure_landlock(proc, 7, workspace, {"enabled": True, "network": "deny", "mode": "landlock"})
        assert "result" in response, response
        if response["result"]["sandboxCapability"] != "enforced":
            print(f"SKIP: network denial needs Landlock ABI 4 ({response['result'].get('sandboxReason', '')})",
                  file=sys.stderr)
        elif shutil.which("python3"):
            probe = ("python3 -c \"import socket; s = socket.socket(); "
                     "s.settimeout(2); s.connect(('127.0.0.1', 9))\"")
            result, output = run_exec_landlock(proc, 8, workspace, probe)
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


def main():
    main_bwrap()
    main_landlock_e2e()


if __name__ == "__main__":
    main()
