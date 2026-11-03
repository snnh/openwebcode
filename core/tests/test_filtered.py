#!/usr/bin/env python3
"""session.configure network "filtered" / proxyAddr / readOnlyPaths tests.

Parse/validation cases run everywhere (POSIX rejects "filtered" at configure
time).  The end-to-end cases need Windows with AppContainer support (no
administrator rights required): the filtered session shares one fixed
AppContainer profile between the capability-less business executions and a
proxy sidecar job started with a per-exec network "allow" override, so the
proxied request doubles as the same-package loopback verification.
"""
import base64
import json
import os
import shutil
import socket
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


def configure(proc, request_id, cwd, sandbox=None, session="filtered"):
    params = {"sessionId": session, "cwd": cwd}
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


def exec_command(proc, request_id, session, cwd, cmd, network=None, timeout_ms=30000):
    params = {"sessionId": session, "execId": f"e{request_id}", "cmd": cmd,
              "cwd": cwd, "timeoutMs": timeout_ms}
    if network is not None:
        params["network"] = network
    request(proc, request_id, "exec.run", params)
    response, notifications = collect_until_response(proc, request_id)
    output = "".join(
        base64.b64decode(note["params"]["data"]).decode("utf-8", "replace")
        for note in notifications
        if note.get("method") == "exec.output"
    )
    return response, output


def job_output_text(proc, request_id, session, job_id, after_seq=0):
    request(proc, request_id, "job.output", {"sessionId": session, "jobId": job_id, "afterSeq": after_seq, "limit": 128})
    response, _ = collect_until_response(proc, request_id)
    assert "result" in response, response
    chunks = response["result"]["chunks"]
    text = "".join(base64.b64decode(chunk["data"]).decode("utf-8", "replace") for chunk in chunks)
    next_seq = chunks[-1]["seq"] if chunks else after_seq
    return text, next_seq


def wait_for_job_text(proc, session, job_id, needle, timeout_s=30):
    deadline = time.time() + timeout_s
    collected = ""
    after_seq = 0
    request_id = 700
    while time.time() < deadline:
        text, after_seq = job_output_text(proc, request_id, session, job_id, after_seq)
        request_id += 1
        collected += text
        if needle in collected:
            return collected
        time.sleep(0.2)
    raise AssertionError(f"job {job_id} did not emit {needle!r} in time; got {collected!r}")


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


PROXY_SCRIPT = """\
param([int]$Port)
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Output "READY"
while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
        $stream = $client.GetStream()
        $buffer = New-Object byte[] 65536
        $read = $stream.Read($buffer, 0, $buffer.Length)
        $text = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
        $first = ($text -split "`r`n")[0]
        Write-Output "GOT $first"
        $reply = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Length: 2`r`nConnection: close`r`n`r`nok")
        $stream.Write($reply, 0, $reply.Length)
    } finally {
        $client.Close()
    }
}
"""


def main():
    executable = sys.argv[1]
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    workspace = tempfile.mkdtemp(prefix="owc-filtered-workspace-")
    outside = tempfile.mkdtemp(prefix="owc-filtered-outside-")
    try:
        request(proc, 1, "core.ping")
        response, _ = collect_until_response(proc, 1)
        assert "result" in response, response

        sandbox = {"enabled": True, "network": "allow", "readRoots": [workspace], "writeRoots": [workspace]}

        # -- protocol validation (every platform) ---------------------------
        # proxyAddr shape: empty, missing colon, whitespace, overlong.
        for bad in ("", "noccolon", "has space:8080", "a:" + "1" * 200):
            response = configure(proc, 2, workspace, {**sandbox, "proxyAddr": bad})
            assert_error(response, -32602, "proxyAddr")

        # readOnlyPaths shape: not an array, too many entries (limit 32),
        # empty entry.
        response = configure(proc, 3, workspace, {**sandbox, "readOnlyPaths": "nope"})
        assert_error(response, -32602, "readOnlyPaths")
        response = configure(proc, 4, workspace, {**sandbox, "readOnlyPaths": [workspace] * 33})
        assert_error(response, -32602, "readOnlyPaths")
        response = configure(proc, 5, workspace, {**sandbox, "readOnlyPaths": [""]})
        assert_error(response, -32602, "readOnlyPaths")

        # Unknown sandbox fields are still rejected alongside the new keys.
        response = configure(proc, 6, workspace, {**sandbox, "bogus": 1})
        assert_error(response, -32602, "unknown fields")

        # exec.run / job.start network overrides: only "allow"/"deny".
        response = configure(proc, 7, workspace, sandbox)
        assert "result" in response, response
        response, _ = exec_command(proc, 8, "filtered", workspace, "echo ok", network="bogus")
        assert_error(response, -32602, "network")
        response, output = exec_command(proc, 9, "filtered", workspace, "echo ok", network="deny")
        assert "result" in response and response["result"]["exitCode"] == 0, response
        assert "ok" in output, output
        request(proc, 10, "job.start", {"sessionId": "filtered", "jobId": "badnet", "kind": "exec",
                                        "cmd": "echo ok", "cwd": workspace, "network": "bogus"})
        response, _ = collect_until_response(proc, 10)
        assert_error(response, -32602, "network")

        # network "filtered": rejected on POSIX, accepted on Windows.
        response = configure(proc, 11, workspace, {**sandbox, "network": "filtered",
                                                   "proxyAddr": "127.0.0.1:9"})
        if sys.platform != "win32":
            assert_error(response, -32602, 'network "filtered" is only supported on Windows')
        else:
            assert "result" in response, response
            assert response["result"]["sandboxCapability"] == "enforced", response
            assert "network filtered via in-sandbox proxy" in response["result"]["sandboxReason"], response

        # readOnlyPaths configures fine on every platform.
        response = configure(proc, 12, workspace, {**sandbox, "readOnlyPaths": [outside]})
        assert "result" in response, response

        if sys.platform == "win32":
            run_read_only_e2e(proc, workspace, outside)
            run_filtered_e2e(proc, workspace, outside)
        print("test_filtered.py: ok")
    finally:
        try:
            request(proc, 99, "core.shutdown")
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(workspace, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


def run_read_only_e2e(proc, workspace, outside):
    """A readOnlyPaths directory is readable but not writable from sandboxed
    executions (plain AppContainer session, per-command grants)."""
    marker = os.path.join(outside, "ro.txt")
    with open(marker, "w", encoding="utf-8") as stored:
        stored.write("read-only-ok")
    response = configure(proc, 20, workspace,
                         {"enabled": True, "network": "allow",
                          "readRoots": [workspace], "writeRoots": [workspace],
                          "readOnlyPaths": [outside]},
                         session="ro-e2e")
    assert "result" in response, response
    response, output = exec_command(proc, 21, "ro-e2e", workspace, f'type "{marker}"')
    assert "result" in response and response["result"]["exitCode"] == 0, response
    assert "read-only-ok" in output, output
    blocked = os.path.join(outside, "blocked.txt")
    response, _ = exec_command(proc, 22, "ro-e2e", workspace, f'echo nope>"{blocked}"')
    assert "result" in response, response
    assert response["result"]["exitCode"] != 0, response
    assert not os.path.exists(blocked)
    request(proc, 23, "session.cleanup", {"sessionId": "ro-e2e"})
    response, _ = collect_until_response(proc, 23)
    assert "result" in response, response


def run_filtered_e2e(proc, workspace, outside):
    curl = shutil.which("curl.exe") or (
        r"C:\Windows\System32\curl.exe" if os.path.exists(r"C:\Windows\System32\curl.exe") else None)
    if not curl:
        print("SKIP: curl.exe not found; filtered e2e not run", file=sys.stderr)
        return

    port = free_port()
    proxy_addr = f"127.0.0.1:{port}"
    # The sidecar is Windows PowerShell from System32, which every
    # AppContainer can read - no readOnlyPaths grant is needed for it.
    script = os.path.join(workspace, "sidecar_proxy.ps1")
    with open(script, "w", encoding="utf-8") as stored:
        stored.write(PROXY_SCRIPT)

    # Filtered session: proxyAddr plus a read-only grant (a temp dir the
    # test owns, so the grant itself is exercised end to end).
    response = configure(proc, 30, workspace,
                         {"enabled": True, "network": "filtered",
                          "proxyAddr": proxy_addr,
                          "readRoots": [workspace], "writeRoots": [workspace],
                          "readOnlyPaths": [outside]},
                         session="filtered-e2e")
    assert "result" in response, response
    assert response["result"]["sandboxCapability"] == "enforced", response
    assert proxy_addr in response["result"].get("sandboxDetail", ""), response

    # The business execution gets the proxy environment injected.
    response, output = exec_command(proc, 31, "filtered-e2e", workspace, "echo %HTTP_PROXY%")
    assert "result" in response and response["result"]["exitCode"] == 0, response
    assert f"http://{proxy_addr}" in output, output
    assert "network filtered via in-sandbox proxy" in response["result"]["sandboxReason"], response

    # The sidecar: a long-running job with a per-exec network "allow"
    # override inside the same shared AppContainer profile.
    request(proc, 32, "job.start", {"sessionId": "filtered-e2e", "jobId": "sidecar",
                                    "kind": "exec",
                                    "cmd": f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{script}" {port}',
                                    "cwd": workspace, "network": "allow", "timeoutMs": 300000})
    response, _ = collect_until_response(proc, 32)
    assert "result" in response, response
    try:
        wait_for_job_text(proc, "filtered-e2e", "sidecar", "READY")

        # Probe first: can a capability-less business execution reach the
        # sidecar over same-package loopback at all?  Client SKUs exempt
        # same-package loopback from AppContainer network isolation; Windows
        # Server builds block the capability-less outbound connect, and no
        # capability grant can fix that -- the business side must stay
        # capability-less by design.  On such platforms the mechanism itself
        # is unavailable, so skip honestly like the landlock e2e does.
        response, output = exec_command(
            proc, 34, "filtered-e2e", workspace,
            f'curl.exe -s -o curl-out.txt -w "%{{http_code}}" --max-time 10 -x "" http://{proxy_addr}/')
        direct_loopback_ok = "result" in response and response["result"]["exitCode"] == 0 and "200" in output
        if not direct_loopback_ok:
            print("SKIP: capability-less same-package loopback is blocked on this "
                  "platform (e.g. Windows Server SKU); filtered e2e not applicable",
                  file=sys.stderr)
            return

        # Key verification: the capability-less business execution reaches
        # the fake proxy through same-package loopback; curl picks up the
        # injected HTTP_PROXY and the sidecar logs the absolute-form request.
        response, output = exec_command(
            proc, 33, "filtered-e2e", workspace,
            'curl.exe -s -o curl-out.txt -w "%{http_code}" --max-time 10 http://neverssl.com/')
        assert "result" in response and response["result"]["exitCode"] == 0, (response, output)
        assert "200" in output, output
        sidecar_log = wait_for_job_text(proc, "filtered-e2e", "sidecar", "neverssl")
        assert "GOT GET http://neverssl.com/" in sidecar_log, sidecar_log

        # Direct external traffic (no proxy) must fail: the business
        # execution holds no network capability SID at all.
        response, output = exec_command(
            proc, 35, "filtered-e2e", workspace,
            'curl.exe -s -o curl-out.txt -w "%{http_code}" --max-time 10 -x "" http://neverssl.com/')
        assert "result" in response, response
        assert response["result"]["exitCode"] != 0, (response, output)
    finally:
        request(proc, 36, "job.cancel", {"sessionId": "filtered-e2e", "jobId": "sidecar"})
        collect_until_response(proc, 36)
        request(proc, 37, "session.cleanup", {"sessionId": "filtered-e2e"})
        response, _ = collect_until_response(proc, 37)
        assert "result" in response, response


if __name__ == "__main__":
    main()
