#!/usr/bin/env python3
import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
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


def assert_landlock_filesystem_isolation_if_enforced(proc):
    """Exercise the real exec path only where Landlock is usable.

    The capability reply is a probe: unsupported kernels and constrained CI
    containers legitimately report advisory/partial.  Do not turn those into
    false failures, but once the configured session reports enforced, require
    the child process to be able to write its workspace and unable to write an
    independent temporary directory.
    """
    if sys.platform != "linux":
        print("SKIP: Landlock integration test requires Linux", file=sys.stderr)
        return

    with tempfile.TemporaryDirectory(prefix="owc-landlock-workspace-") as workspace, \
         tempfile.TemporaryDirectory(prefix="owc-landlock-outside-") as outside:
        inside_path = os.path.join(workspace, "workspace-write.txt")
        outside_path = os.path.join(outside, "outside-write.txt")
        request(proc, 41, "session.configure", {
            "sessionId": "landlock",
            "cwd": workspace,
            "sandbox": {"enabled": True, "network": "allow"},
        })
        response, _ = collect_until_response(proc, 41)
        assert "result" in response, response
        capability = response["result"]["sandboxCapability"]
        if capability != "enforced":
            reason = response["result"].get("sandboxReason", "unknown reason")
            print(
                f"SKIP: Landlock integration test needs enforced capability ({capability}: {reason})",
                file=sys.stderr,
            )
            return

        command = (
            f"printf workspace-ok > {shlex.quote(inside_path)}; "
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
        assert not os.path.exists(outside_path), outside_path


def main():
    executable = sys.argv[1]
    environment = os.environ.copy()
    pwsh_available = shutil.which("pwsh", path=environment.get("PATH")) is not None
    hosted_windows = os.name == "nt" and environment.get("GITHUB_ACTIONS", "").lower() == "true"
    pwsh_integration = pwsh_available and not hosted_windows
    use_pwsh_main_channel = os.name == "nt" and pwsh_integration
    shell_params = {"shellBackend": "pwsh"} if use_pwsh_main_channel else {}
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    binary_name = f"protocol-upload-{os.getpid()}.bin"
    binary_path = os.path.join(os.getcwd(), binary_name)
    try:
        request(proc, "ping-中文", "core.ping")
        response, notes = collect_until_response(proc, "ping-中文")
        assert not notes
        assert response["result"]["version"] == "0.3.6"
        assert response["result"]["sandboxCapability"] in {"advisory", "partial", "enforced"}
        assert response["result"]["sandboxReason"]
        assert response["result"]["protocolVersion"] == "1.0"
        assert response["result"]["features"]["fsWriteBase64"] is True
        assert response["result"]["features"]["fsStatMany"] is True
        assert response["result"]["features"]["fsHash"] is True
        assert response["result"]["features"]["fsScanPagination"] is True
        assert response["result"]["features"]["fsWatch"] is True
        assert response["result"]["features"]["jobControl"] is (os.name == "nt")
        assert response["result"]["limits"] == {"maxFrameBytes": 32 * 1024 * 1024, "maxWriteBase64Bytes": 20 * 1024 * 1024, "maxHashBytes": 16 * 1024 * 1024, "maxStatManyPaths": 128, "maxStatManyPathBytes": 256 * 1024, "maxScanEntries": 256, "maxScanDepth": 16, "maxScanNodes": 2048, "maxWatches": 16, "maxWatchEvents": 128, "maxConcurrentJobs": 4, "maxJobOutputBytes": 512 * 1024}

        request(proc, None, "core.ping")
        response, notes = collect_until_response(proc, None)
        assert not notes
        assert response["id"] is None
        assert response["result"]["version"] == "0.3.6"

        send(proc, {"jsonrpc": "2.0", "method": "core.ping", "params": {}})
        request(proc, "after-notification", "core.ping")
        response, notes = collect_until_response(proc, "after-notification")
        assert not notes
        assert response["result"]["version"] == "0.3.6"

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
            response, notes = collect_until_response(proc, 302)
            if os.name == "nt":
                assert response.get("error", {}).get("message") == "pwsh executable was not found", response
            else:
                assert response.get("result", {}).get("exitCode") == 127, response
                output = b"".join(base64.b64decode(n["params"]["data"]) for n in notes)
                assert b"pwsh executable was not found" in output, output
        else:
            print("SKIP: GitHub-hosted Windows retains pwsh children past Core timeouts", file=sys.stderr)

        request(proc, 303, "core.ping")
        response, _ = collect_until_response(proc, 303)
        assert "result" in response, response

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

        # 非法值：0、超上限、非数字一律拒绝
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
        assert response["result"]["sandboxCapability"] == "partial"

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
        stderr = proc.stderr.read().decode(errors="replace")
        if stderr:
            print(stderr, file=sys.stderr)


if __name__ == "__main__":
    main()
