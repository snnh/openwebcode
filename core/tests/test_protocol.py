#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


def expected_version():
    """The reported core version must follow project(VERSION) in CMakeLists."""
    cmake = pathlib.Path(__file__).resolve().parent.parent / "CMakeLists.txt"
    match = re.search(
        r"project\s*\(\s*openwebcode_core\s+VERSION\s+([0-9]+\.[0-9]+\.[0-9]+)",
        cmake.read_text(encoding="utf-8"),
    )
    assert match, "project(VERSION) not found in core/CMakeLists.txt"
    return match.group(1)


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


def assert_landlock_filesystem_isolation_if_enforced(proc):
    """Exercise the real exec path only where Landlock is usable.

    The session pins mode "landlock" so the case exercises the Landlock
    backend regardless of the platform default (bubblewrap is the default
    backend where usable).  The capability reply is a probe: unsupported
    kernels and constrained CI containers legitimately report
    advisory/partial.  Do not turn those into false failures, but once the
    configured session reports enforced, require the child process to be
    able to write its workspace and unable to write an independent
    directory.  /tmp is a deliberate runtime exemption, so the "outside"
    directory must live under the user home (not exempt) rather than the
    system temp dir.
    """
    if sys.platform != "linux":
        print("SKIP: Landlock integration test requires Linux", file=sys.stderr)
        return

    with tempfile.TemporaryDirectory(prefix="owc-landlock-workspace-") as workspace, \
         tempfile.TemporaryDirectory(prefix="owc-landlock-allowed-") as allowed, \
         tempfile.TemporaryDirectory(prefix="owc-landlock-outside-", dir=os.path.expanduser("~")) as outside:
        inside_path = os.path.join(workspace, "workspace-write.txt")
        allowed_path = os.path.join(allowed, "allowed-write.txt")
        outside_path = os.path.join(outside, "outside-write.txt")
        request(proc, 41, "session.configure", {
            "sessionId": "landlock",
            "cwd": workspace,
            "sandbox": {"enabled": True, "network": "allow", "mode": "landlock", "allowPaths": [allowed]},
        })
        response, _ = collect_until_response(proc, 41)
        assert "result" in response, response
        capability = response["result"]["sandboxCapability"]
        # Linux must never report the Windows Job Object wording: a default
        # enabled session reflects the Landlock probe result.
        assert "Job Object" not in response["result"].get("sandboxReason", ""), response
        assert "Job Object" not in response["result"].get("sandboxDetail", ""), response
        if capability != "enforced":
            reason = response["result"].get("sandboxReason", "unknown reason")
            print(
                f"SKIP: Landlock integration test needs enforced capability ({capability}: {reason})",
                file=sys.stderr,
            )
            return

        command = (
            f"printf workspace-ok > {shlex.quote(inside_path)}; "
            f"printf allowed-ok > {shlex.quote(allowed_path)}; "
            f"printf outside-must-fail > {shlex.quote(outside_path)}"
        )
        request(proc, 42, "exec.run", {
            "sessionId": "landlock",
            "execId": "landlock-write-boundary",
            "cmd": command,
            "cwd": workspace,
            "timeoutMs": 5000,
        })
        response, _ = collect_until_response(proc, 42)
        assert "result" in response, response
        result = response["result"]
        assert result["sandboxCapability"] == "enforced", result
        assert result["exitCode"] != 0, result
        with open(inside_path, "r", encoding="utf-8") as stored:
            assert stored.read() == "workspace-ok"
        with open(allowed_path, "r", encoding="utf-8") as stored:
            assert stored.read() == "allowed-ok"
        assert not os.path.exists(outside_path), outside_path


def assert_posix_children_killed_on_core_exit(executable):
    """A core that exits must SIGKILL its spawned process groups (POSIX)."""
    if os.name == "nt" or shutil.which("pgrep") is None:
        return
    marker = "sleep 31337"
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        request(proc, 1, "session.configure", {"sessionId": "orphan", "cwd": os.getcwd(), "sandbox": {"enabled": False}})
        response, _ = collect_until_response(proc, 1)
        assert "result" in response, response
        request(proc, 2, "job.start", {"sessionId": "orphan", "jobId": "long", "kind": "exec", "cmd": f"exec {marker}", "cwd": os.getcwd(), "timeoutMs": 300000})
        response, _ = collect_until_response(proc, 2)
        assert response.get("result", {}).get("state") == "running", response
        time.sleep(0.5)
        assert subprocess.run(["pgrep", "-f", marker], capture_output=True).returncode == 0
        proc.terminate()
        proc.wait(timeout=5)
        survived = True
        for _ in range(30):
            if subprocess.run(["pgrep", "-f", marker], capture_output=True).returncode != 0:
                survived = False
                break
            time.sleep(0.1)
        assert not survived, "spawned child survived core exit"
    finally:
        if proc.poll() is None:
            proc.kill()
        subprocess.run(["pkill", "-f", marker], capture_output=True)


def main():
    executable = sys.argv[1]
    version = expected_version()
    environment = os.environ.copy()
    pwsh_available = shutil.which("pwsh", path=environment.get("PATH")) is not None
    hosted_ci = environment.get("GITHUB_ACTIONS", "").lower() == "true"
    pwsh_integration = pwsh_available and not hosted_ci
    use_pwsh_main_channel = os.name == "nt" and pwsh_integration
    shell_params = {"shellBackend": "pwsh"} if use_pwsh_main_channel else {}
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    binary_name = f"protocol-upload-{os.getpid()}.bin"
    binary_path = os.path.join(os.getcwd(), binary_name)
    text_name = f"protocol-cas-{os.getpid()}.txt"
    text_path = os.path.join(os.getcwd(), text_name)
    try:
        request(proc, "ping-中文", "core.ping")
        response, notes = collect_until_response(proc, "ping-中文")
        assert not notes
        assert response["result"]["version"] == version
        assert response["result"]["sandboxCapability"] in {"advisory", "partial", "enforced"}
        assert response["result"]["sandboxReason"]
        assert response["result"]["protocolVersion"] == "1.0"
        assert response["result"]["features"]["fsWriteBase64"] is True
        assert response["result"]["features"]["fsReadBase64"] is True
        assert response["result"]["features"]["fsStatMany"] is True
        assert response["result"]["features"]["fsHash"] is True
        assert response["result"]["features"]["fsScanPagination"] is True
        assert response["result"]["features"]["fsWatch"] is True
        assert response["result"]["features"]["indexScan"] is True
        assert response["result"]["features"]["grepJob"] is True
        assert response["result"]["features"]["globJob"] is True
        assert response["result"]["features"]["indexExtract"] is True
        assert response["result"]["features"]["jobControl"] is (os.name == "nt")
        assert response["result"]["features"]["shellBash"] is True
        overlay_feature = response["result"]["features"].get("overlay")
        assert isinstance(overlay_feature, dict), response["result"]["features"]
        assert set(overlay_feature) == {"supported", "fuseOverlayfs", "kernelMount"}, overlay_feature
        if os.name == "nt":
            assert overlay_feature == {"supported": False, "fuseOverlayfs": False, "kernelMount": False}, overlay_feature
        else:
            assert all(isinstance(value, bool) for value in overlay_feature.values()), overlay_feature
        assert response["result"]["limits"] == {"maxFrameBytes": 32 * 1024 * 1024, "maxWriteBase64Bytes": 20 * 1024 * 1024, "maxReadBase64Bytes": 20 * 1024 * 1024, "maxHashBytes": 16 * 1024 * 1024, "maxStatManyPaths": 128, "maxStatManyPathBytes": 256 * 1024, "maxScanEntries": 256, "maxScanDepth": 16, "maxScanNodes": 2048, "maxWatches": 16, "maxWatchEvents": 128, "maxConcurrentJobs": 4, "maxJobOutputBytes": 512 * 1024, "maxIndexScanNodes": 1000000, "maxIndexScanDepth": 64, "maxIndexScanBytes": 16 * 1024 * 1024 * 1024, "maxIndexScanMs": 600000, "maxSearchNodes": 1000000, "maxSearchDepth": 64, "maxSearchMs": 300000, "maxIndexExtractFiles": 4096, "maxIndexExtractBytes": 1024 * 1024 * 1024, "maxIndexExtractMs": 300000, "indexExtractDefaultSymbolsPerFile": 200, "maxIndexExtractSymbolsPerFile": 10000, "maxConcurrentPtys": 16, "maxPtyOutputChunkBytes": 64 * 1024, "maxPtyInputBytes": 8 * 1024}

        request(proc, None, "core.ping")
        response, notes = collect_until_response(proc, None)
        assert not notes
        assert response["id"] is None
        assert response["result"]["version"] == version

        send(proc, {"jsonrpc": "2.0", "method": "core.ping", "params": {}})
        request(proc, "after-notification", "core.ping")
        response, notes = collect_until_response(proc, "after-notification")
        assert not notes
        assert response["result"]["version"] == version

        request(proc, 2, "missing.method")
        response, _ = collect_until_response(proc, 2)
        assert response["error"]["code"] == -32601

        if use_pwsh_main_channel:
            command = "Write-Output hello; [Console]::Error.WriteLine('error'); exit 7"
            slow = "Start-Sleep -Seconds 5"
        elif os.name == "nt":
            command = "echo hello&& echo error 1>&2&& exit /b 7"
            slow = "ping -n 6 127.0.0.1 >nul"
        else:
            command = "printf hello; printf error >&2; exit 7"
            slow = "sleep 5"

        request(proc, 21, "session.configure", {"sessionId": "s1", "cwd": os.getcwd(), "sandbox": {"enabled": False, "allowPaths": [os.getcwd()], "denyPaths": [], "network": "allow"}})
        response, _ = collect_until_response(proc, 21)
        assert response["result"]["sandboxCapability"] in {"advisory", "partial", "enforced"}

        # Conditional text writes reject a stale editor revision instead of
        # silently overwriting a file changed since it was read.
        request(proc, 212, "fs.write", {"sessionId": "s1", "path": text_name, "content": "one"})
        response, _ = collect_until_response(proc, 212)
        assert response.get("result", {}).get("ok") is True, response
        first_digest = hashlib.sha256(b"one").hexdigest()
        request(proc, 213, "fs.write", {"sessionId": "s1", "path": text_name, "content": "two", "expectedSha256": first_digest})
        response, _ = collect_until_response(proc, 213)
        assert response.get("result", {}).get("ok") is True, response
        request(proc, 214, "fs.write", {"sessionId": "s1", "path": text_name, "content": "stale", "expectedSha256": first_digest})
        response, _ = collect_until_response(proc, 214)
        assert response.get("error", {}).get("code") == -32004, response
        with open(text_path, "r", encoding="utf-8") as stored:
            assert stored.read() == "two"

        # Binary ingress is a dedicated, bounded base64 RPC. It must preserve
        # bytes that fs.write intentionally rejects as non-UTF-8/text data.
        binary = b"%PDF-1.7\x00binary\n%%EOF\n"
        request(proc, 210, "fs.writeBase64", {"sessionId": "s1", "path": binary_name, "data": base64.b64encode(binary).decode("ascii"), "createDirs": True})
        response, _ = collect_until_response(proc, 210)
        assert response.get("result", {}).get("ok") is True, response
        with open(binary_path, "rb") as stored:
            assert stored.read() == binary
        request(proc, 211, "fs.writeBase64", {"sessionId": "s1", "path": "bad-upload.bin", "data": "A===", "createDirs": True})
        response, _ = collect_until_response(proc, 211)
        assert response.get("error", {}).get("code") == -32602, response

        # allowPaths is a bounded array of non-empty strings.
        for bad_id, allow_paths in [
            (22, "not-an-array"),
            (23, [""]),
            (24, list(map(str, range(17)))),
        ]:
            request(proc, bad_id, "session.configure", {"sessionId": "invalid-allow", "cwd": os.getcwd(), "sandbox": {"enabled": False, "allowPaths": allow_paths}})
            response, _ = collect_until_response(proc, bad_id)
            assert "error" in response, (allow_paths, response)

        # session.configure is transactional: an invalid replacement must not
        # destroy the live cwd/policy, and failed new sessions must not consume
        # any of the fixed 64 slots.
        request(proc, "invalid-reconfigure", "session.configure", {
            "sessionId": "s1",
            "cwd": os.path.dirname(os.getcwd()),
            "sandbox": {"enabled": "not-a-boolean"},
        })
        response, _ = collect_until_response(proc, "invalid-reconfigure")
        assert "error" in response, response
        request(proc, "read-after-invalid", "fs.read", {"sessionId": "s1", "path": text_name})
        response, _ = collect_until_response(proc, "read-after-invalid")
        assert response.get("result", {}).get("content") == "two", response
        for slot in range(70):
            request(proc, f"invalid-slot-{slot}", "session.configure", {
                "sessionId": f"invalid-slot-{slot}",
                "cwd": os.getcwd(),
                "sandbox": {"network": "invalid"},
            })
            response, _ = collect_until_response(proc, f"invalid-slot-{slot}")
            assert "error" in response, response
        request(proc, "valid-after-invalid-slots", "session.configure", {
            "sessionId": "valid-after-invalid-slots",
            "cwd": os.getcwd(),
            "sandbox": {"enabled": False},
        })
        response, _ = collect_until_response(proc, "valid-after-invalid-slots")
        assert "result" in response, response
        request(proc, "cleanup-valid-after-invalid", "session.cleanup", {"sessionId": "valid-after-invalid-slots"})
        response, _ = collect_until_response(proc, "cleanup-valid-after-invalid")
        assert response.get("result", {}).get("ok") is True, response

        request(proc, 3, "exec.run", {"sessionId": "s1", "execId": "e1", "cmd": command, "cwd": os.getcwd(), "timeoutMs": 5000, **shell_params})
        response, notes = collect_until_response(proc, 3)
        assert "result" in response, response
        assert response["result"]["exitCode"] == 7
        assert [n["params"]["seq"] for n in notes] == list(range(len(notes)))
        output = b"".join(base64.b64decode(n["params"]["data"]) for n in notes)
        assert b"hello" in output and b"error" in output

        request(proc, 301, "exec.run", {"sessionId": "s1", "execId": "bad-shell", "cmd": "echo no", "cwd": os.getcwd(), "shellBackend": "powershell"})
        response, _ = collect_until_response(proc, 301)
        assert response.get("error", {}).get("code") == -32602, response

        # exec.run clamps timeoutMs to ten minutes instead of rejecting:
        # an oversized value must still run a fast command normally.
        request(proc, 304, "exec.run", {"sessionId": "s1", "execId": "huge-timeout", "cmd": command, "cwd": os.getcwd(), "timeoutMs": 2147483647, **shell_params})
        response, _ = collect_until_response(proc, 304)
        assert response.get("result", {}).get("exitCode") == 7, response

        if pwsh_integration:
            # A cold pwsh start on hosted Linux can occasionally exceed five
            # seconds. Keep the real integration coverage with enough startup
            # headroom while remaining well below the enclosing CTest timeout.
            request(proc, 302, "exec.run", {"sessionId": "s1", "execId": "pwsh", "cmd": "Write-Output pwsh-ok; exit 9", "cwd": os.getcwd(), "timeoutMs": 15000, "shellBackend": "pwsh"})
            response, notes = collect_until_response(proc, 302)
            assert response.get("result", {}).get("exitCode") == 9, response
            output = b"".join(base64.b64decode(n["params"]["data"]) for n in notes)
            assert b"pwsh-ok" in output, output
        elif not pwsh_available:
            request(proc, 302, "exec.run", {"sessionId": "s1", "execId": "pwsh", "cmd": "Write-Output pwsh-ok; exit 9", "cwd": os.getcwd(), "timeoutMs": 5000, "shellBackend": "pwsh"})
            response, _ = collect_until_response(proc, 302)
            # Both platforms surface the same stable shell_unavailable error
            # for an explicitly selected interpreter that is missing.
            assert response.get("error", {}).get("message") == "pwsh executable was not found", response
        else:
            print("SKIP: hosted CI can retain pwsh children past Core timeouts", file=sys.stderr)

        # shellBackend=bash with an explicit shellPath (Git Bash on Windows,
        # bash on POSIX).  Windows PATH hits in System32 (the WSL launcher)
        # are excluded by both the host detection layer and the Core fallback.
        bash_path = None
        if os.name == "nt":
            bash_candidates = []
            path_bash = shutil.which("bash", path=environment.get("PATH"))
            system32_dir = os.path.normcase(os.path.join(environment.get("SystemRoot", r"C:\Windows"), "System32"))
            if path_bash and os.path.normcase(os.path.dirname(os.path.abspath(path_bash))) != system32_dir:
                bash_candidates.append(path_bash)
            bash_candidates.append("C:\\Program Files\\Git\\bin\\bash.exe")
            if environment.get("LOCALAPPDATA"):
                bash_candidates.append(os.path.join(environment["LOCALAPPDATA"], "Programs", "Git", "bin", "bash.exe"))
            bash_path = next((candidate for candidate in bash_candidates if os.path.isfile(candidate)), None)
        else:
            bash_path = shutil.which("bash", path=environment.get("PATH"))
        if bash_path:
            request(proc, 310, "exec.run", {"sessionId": "s1", "execId": "bash", "cmd": "echo bash-ok; exit 5", "cwd": os.getcwd(), "timeoutMs": 15000, "shellBackend": "bash", "shellPath": bash_path})
            response, notes = collect_until_response(proc, 310)
            assert response.get("result", {}).get("exitCode") == 5, response
            output = b"".join(base64.b64decode(n["params"]["data"]) for n in notes)
            assert b"bash-ok" in output, output
            # Quoting: double quotes and backslashes inside the command must
            # survive the CRT/MSYS command-line decoding byte-for-byte (an
            # unescaped \" would close the wrapped -c argument early, and the
            # v="a b" assignment would then fail with a non-zero exit).
            request(proc, 315, "exec.run", {"sessionId": "s1", "execId": "bash-quoting", "cmd": "v=\"a b\"; echo \"$v\"; echo \"a\\b\"; exit 0", "cwd": os.getcwd(), "timeoutMs": 15000, "shellBackend": "bash", "shellPath": bash_path})
            response, notes = collect_until_response(proc, 315)
            assert response.get("result", {}).get("exitCode") == 0, response
            output = b"".join(base64.b64decode(n["params"]["data"]) for n in notes)
            assert b"a b" in output, output
            assert b"a\\b" in output, output
        else:
            print("SKIP: no bash found for shellBackend=bash integration", file=sys.stderr)

        if os.name != "nt":
            # POSIX parity: a shellPath pointing at a missing executable makes
            # exec fail with ENOENT, which the platform layer reports as the
            # same stable shell_unavailable error. Windows only flags its own
            # PATH-search misses; an explicit path there fails process
            # creation with a generic start error instead.
            request(proc, 320, "exec.run", {"sessionId": "s1", "execId": "missing-bash-path", "cmd": "echo no", "cwd": os.getcwd(), "timeoutMs": 5000, "shellBackend": "bash", "shellPath": "/nonexistent/owc-missing-shell"})
            response, _ = collect_until_response(proc, 320)
            assert response.get("error", {}).get("message") == "bash executable was not found", response
            request(proc, 321, "job.start", {"sessionId": "s1", "jobId": "missing-bash-path", "kind": "exec", "cmd": "echo no", "cwd": os.getcwd(), "timeoutMs": 5000, "shellBackend": "bash", "shellPath": "/nonexistent/owc-missing-shell"})
            response, _ = collect_until_response(proc, 321)
            assert response["result"]["state"] == "running", response
            for _ in range(30):
                request(proc, 322, "job.status", {"sessionId": "s1", "jobId": "missing-bash-path"})
                response, _ = collect_until_response(proc, 322)
                if response["result"]["state"] != "running": break
                time.sleep(0.05)
            assert response["result"]["state"] == "failed", response
            assert response["result"]["error"] == "bash executable was not found", response

        # exec.run rejects unknown fields.
        request(proc, 312, "exec.run", {"sessionId": "s1", "execId": "unknown-field", "cmd": "echo no", "cwd": os.getcwd(), "bogus": 1})
        response, _ = collect_until_response(proc, 312)
        assert response.get("error", {}).get("code") == -32602, response

        # shellPath is not part of the index.scan field whitelist.
        request(proc, 314, "job.start", {"sessionId": "s1", "jobId": "scan-with-shell", "kind": "index.scan", "path": ".", "cwd": os.getcwd(), "shellPath": bash_path or "bash"})
        response, _ = collect_until_response(proc, 314)
        assert response.get("error", {}).get("code") == -32602, response

        # job.start kind=exec rejects an empty cmd with a parameter error
        # instead of running a no-op worker on an uninitialized result.
        request(proc, 319, "job.start", {"sessionId": "s1", "jobId": "empty-cmd", "kind": "exec", "cmd": "", "cwd": os.getcwd()})
        response, _ = collect_until_response(proc, 319)
        assert response.get("error", {}).get("code") == -32602, response

        if os.name == "nt" and bash_path:
            # job.start kind=exec accepts shellBackend=bash + shellPath.
            request(proc, 316, "job.start", {"sessionId": "s1", "jobId": "bash-job", "kind": "exec", "cmd": "echo bash-job-ok; exit 3", "cwd": os.getcwd(), "timeoutMs": 15000, "shellBackend": "bash", "shellPath": bash_path})
            response, _ = collect_until_response(proc, 316)
            assert response["result"]["state"] == "running", response
            for _ in range(60):
                request(proc, 317, "job.status", {"sessionId": "s1", "jobId": "bash-job"})
                response, _ = collect_until_response(proc, 317)
                if response["result"]["state"] != "running": break
                time.sleep(0.05)
            assert response["result"]["state"] == "completed", response
            assert response["result"]["exitCode"] == 3, response
            request(proc, 318, "job.output", {"sessionId": "s1", "jobId": "bash-job", "afterSeq": 0})
            response, _ = collect_until_response(proc, 318)
            assert any(b"bash-job-ok" in base64.b64decode(chunk["data"]) for chunk in response["result"]["chunks"]), response

        request(proc, 303, "core.ping")
        response, _ = collect_until_response(proc, 303)
        assert "result" in response, response

        # Unknown params fields are rejected everywhere: parameterless
        # methods, session.cleanup, and the sandbox sub-object.
        request(proc, 305, "core.ping", {"bogus": 1})
        response, _ = collect_until_response(proc, 305)
        assert response.get("error", {}).get("code") == -32602, response
        request(proc, 306, "core.shutdown", {"bogus": 1})
        response, _ = collect_until_response(proc, 306)
        assert response.get("error", {}).get("code") == -32602, response
        request(proc, 307, "session.cleanup", {"sessionId": "s1", "bogus": 1})
        response, _ = collect_until_response(proc, 307)
        assert response.get("error", {}).get("code") == -32602, response
        request(proc, 308, "session.configure", {"sessionId": "s1", "cwd": os.getcwd(), "sandbox": {"enabled": False, "bogus": 1}})
        response, _ = collect_until_response(proc, 308)
        assert response.get("error", {}).get("code") == -32602, response
        # A rejected core.shutdown must not stop the core, and the rejected
        # cleanup/configure must not disturb s1.
        request(proc, 309, "core.ping")
        response, _ = collect_until_response(proc, 309)
        assert "result" in response, response
        request(proc, 311, "exec.run", {"sessionId": "s1", "execId": "after-reject", "cmd": command, "cwd": os.getcwd(), "timeoutMs": 5000, **shell_params})
        response, _ = collect_until_response(proc, 311)
        assert response["result"]["exitCode"] == 7, response

        assert_landlock_filesystem_isolation_if_enforced(proc)

        started = time.monotonic()
        request(proc, 4, "exec.run", {"sessionId": "s1", "execId": "e2", "cmd": slow, "cwd": os.getcwd(), "timeoutMs": 100, **shell_params})
        response, _ = collect_until_response(proc, 4)
        assert response["error"]["code"] == -32001
        assert time.monotonic() - started < 4

        if os.name == "nt":
            # job.start returns immediately; cancellation only targets its own
            # Job Object and leaves the shared Core available for status RPCs.
            request(proc, 40, "job.start", {"sessionId": "s1", "jobId": "cancel-me", "kind": "exec", "cmd": slow, "cwd": os.getcwd(), "timeoutMs": 5000, **shell_params})
            response, _ = collect_until_response(proc, 40)
            assert response["result"] == {"jobId": "cancel-me", "state": "running"}, response
            request(proc, 41, "job.status", {"sessionId": "s1", "jobId": "cancel-me"})
            response, _ = collect_until_response(proc, 41)
            assert response["result"] ["jobId"] == "cancel-me" and response["result"]["state"] == "running", response
            request(proc, 42, "job.cancel", {"sessionId": "s1", "jobId": "cancel-me"})
            response, _ = collect_until_response(proc, 42)
            assert response["result"] == {"jobId": "cancel-me", "accepted": True}, response
            for _ in range(30):
                request(proc, 43, "job.status", {"sessionId": "s1", "jobId": "cancel-me"})
                response, _ = collect_until_response(proc, 43)
                if response["result"]["state"] != "running": break
                time.sleep(0.05)
            assert response["result"]["state"] == "cancelled", response
            output_command = "Write-Output job-output" if use_pwsh_main_channel else "echo job-output"
            request(proc, 44, "job.start", {"sessionId": "s1", "jobId": "output-me", "kind": "exec", "cmd": output_command, "cwd": os.getcwd(), "timeoutMs": 5000, **shell_params})
            response, _ = collect_until_response(proc, 44)
            assert response["result"]["state"] == "running", response
            for _ in range(30):
                request(proc, 45, "job.status", {"sessionId": "s1", "jobId": "output-me"})
                response, _ = collect_until_response(proc, 45)
                if response["result"]["state"] != "running": break
                time.sleep(0.05)
            assert response["result"]["state"] == "completed", response
            request(proc, 46, "job.output", {"sessionId": "s1", "jobId": "output-me", "afterSeq": 0})
            response, _ = collect_until_response(proc, 46)
            assert any(b"job-output" in base64.b64decode(chunk["data"]) for chunk in response["result"]["chunks"]), response

            # A just-started quiet job has no output yet. job.output must grow
            # the JSON suffix buffer even when the chunk loop emits nothing;
            # this previously corrupted the Windows heap and killed Core.
            quiet_command = "Start-Sleep -Seconds 3; Write-Output delayed" if use_pwsh_main_channel else "ping -n 3 127.0.0.1 >nul & echo delayed"
            request(proc, 49, "job.start", {"sessionId": "s1", "jobId": "quiet-output", "kind": "exec", "cmd": quiet_command, "cwd": os.getcwd(), "timeoutMs": 5000, **shell_params})
            response, _ = collect_until_response(proc, 49)
            assert response["result"]["state"] == "running", response
            request(proc, 50, "job.output", {"sessionId": "s1", "jobId": "quiet-output", "afterSeq": 0})
            response, _ = collect_until_response(proc, 50)
            assert response["result"] == {"chunks": [], "nextSeq": 0, "truncated": False}, response
            request(proc, 51, "job.cancel", {"sessionId": "s1", "jobId": "quiet-output"})
            response, _ = collect_until_response(proc, 51)
            assert response["result"]["accepted"] is True, response

        if not pwsh_available:
            # job.status reports the same stable shell_unavailable error on
            # both platforms when the selected interpreter is missing.
            request(proc, 47, "job.start", {"sessionId": "s1", "jobId": "missing-pwsh", "kind": "exec", "cmd": "Write-Output no", "cwd": os.getcwd(), "timeoutMs": 5000, "shellBackend": "pwsh"})
            response, _ = collect_until_response(proc, 47)
            assert response["result"]["state"] == "running", response
            for _ in range(30):
                request(proc, 48, "job.status", {"sessionId": "s1", "jobId": "missing-pwsh"})
                response, _ = collect_until_response(proc, 48)
                if response["result"]["state"] != "running": break
                time.sleep(0.05)
            assert response["result"]["state"] == "failed", response
            assert response["result"]["error"] == "pwsh executable was not found", response

        if os.name == "nt":
            # jobobject 兼容模式：默认 Job Object 限制在回复中如实上报
            request(proc, 30, "session.configure", {"sessionId": "s2", "cwd": os.getcwd(), "sandbox": {"enabled": True, "mode": "jobobject"}})
            response, _ = collect_until_response(proc, 30)
            assert response["result"]["sandboxCapability"] == "partial"
            detail = response["result"]["sandboxDetail"]
            assert "4096" in detail and "64" in detail

            # 显式覆盖 jobMemoryMB / jobMaxProcesses
            request(proc, 31, "session.configure", {"sessionId": "s2", "cwd": os.getcwd(), "sandbox": {"enabled": True, "mode": "jobobject", "jobMemoryMB": 2048, "jobMaxProcesses": 32}})
            response, _ = collect_until_response(proc, 31)
            detail = response["result"]["sandboxDetail"]
            assert "2048" in detail and "32" in detail
        else:
            # POSIX 忽略 mode，一律如实上报 Landlock 能力，不得出现 Windows Job Object 文案
            request(proc, 30, "session.configure", {"sessionId": "s2", "cwd": os.getcwd(), "sandbox": {"enabled": True, "mode": "jobobject"}})
            response, _ = collect_until_response(proc, 30)
            assert response["result"]["sandboxCapability"] in {"advisory", "partial", "enforced"}
            assert "Job Object" not in response["result"]["sandboxReason"]
            assert "Job Object" not in response["result"].get("sandboxDetail", "")

        # 非法值：0、超上限、非数字一律拒绝（平台无关的字段校验）
        for bad_id, field, value in [
            (32, "jobMemoryMB", 0), (33, "jobMemoryMB", 1048577), (34, "jobMemoryMB", "2048"),
            (35, "jobMaxProcesses", 0), (36, "jobMaxProcesses", 4097), (37, "jobMaxProcesses", "64"),
        ]:
            request(proc, bad_id, "session.configure", {"sessionId": "s2", "cwd": os.getcwd(), "sandbox": {"enabled": True, "mode": "jobobject", field: value}})
            response, _ = collect_until_response(proc, bad_id)
            assert "error" in response, (field, value, response)

        # 上限边界值合法
        request(proc, 38, "session.configure", {"sessionId": "s2", "cwd": os.getcwd(), "sandbox": {"enabled": True, "mode": "jobobject", "jobMemoryMB": 1048576, "jobMaxProcesses": 4096}})
        response, _ = collect_until_response(proc, 38)
        if os.name == "nt":
            assert response["result"]["sandboxCapability"] == "partial"
        else:
            assert response["result"]["sandboxCapability"] in {"advisory", "partial", "enforced"}
            assert "Job Object" not in response["result"]["sandboxReason"]

        # jobobject 模式下 exec.run 正常工作（sandbox 启用时 shell 固定为 cmd.exe）
        job_command = "echo hello&& exit /b 7" if os.name == "nt" else "printf hello; exit 7"
        request(proc, 39, "exec.run", {"sessionId": "s2", "execId": "e3", "cmd": job_command, "cwd": os.getcwd(), "timeoutMs": 5000})
        response, _ = collect_until_response(proc, 39)
        assert response["result"]["exitCode"] == 7
        if os.name == "nt":
            assert response["result"]["sandboxCapability"] == "partial"

        if os.name == "nt":
            # 进程树收编：start /b 拉起的孙进程落在同一 Job 内；超时走
            # TerminateJobObject 终止整树，孙进程的 survived 标记永不落盘
            started_marker = os.path.join(os.getcwd(), "job_tree_started.txt")
            survived_marker = os.path.join(os.getcwd(), "job_tree_survived.txt")
            grandchild = os.path.join(os.getcwd(), "job_tree_grandchild.cmd")
            for marker in (started_marker, survived_marker):
                if os.path.exists(marker):
                    os.remove(marker)
            with open(grandchild, "w", newline="") as script:
                # ping 而非 timeout：Git usr/bin 在 PATH 时 timeout 会命中 GNU 版本
                script.write("@echo off\r\necho started> job_tree_started.txt\r\nping -n 4 127.0.0.1 >nul\r\necho survived> job_tree_survived.txt\r\n")
            request(proc, 40, "exec.run", {"sessionId": "s2", "execId": "e4", "cmd": "start /b cmd /c job_tree_grandchild.cmd & ping -n 30 127.0.0.1 >nul", "cwd": os.getcwd(), "timeoutMs": 2000})
            response, _ = collect_until_response(proc, 40)
            assert response["error"]["code"] == -32001
            deadline = time.monotonic() + 5
            while not os.path.exists(started_marker) and time.monotonic() < deadline:
                time.sleep(0.1)
            assert os.path.exists(started_marker)
            # 孙进程若无 Job 约束会在启动后约 3 秒写出 survived（此刻绝对时间已足够）
            time.sleep(3)
            assert not os.path.exists(survived_marker)
            for marker in (grandchild, started_marker, survived_marker):
                if os.path.exists(marker):
                    os.remove(marker)

        request(proc, 5, "core.shutdown")
        response, _ = collect_until_response(proc, 5)
        assert response["result"]["ok"] is True
        assert proc.wait(timeout=5) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
        if os.path.exists(binary_path):
            os.remove(binary_path)
        if os.path.exists(text_path):
            os.remove(text_path)
        stderr = proc.stderr.read().decode(errors="replace")
        if stderr:
            print(stderr, file=sys.stderr)
    assert_posix_children_killed_on_core_exit(executable)


if __name__ == "__main__":
    main()
