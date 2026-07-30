#!/usr/bin/env python3
"""Stress owc-exec with an /init-like workload to reproduce heap corruption."""
import json
import os
import subprocess
import sys

CORE = sys.argv[1] if len(sys.argv) > 1 else r"D:\dev\openwebcode\build\Debug\owc-exec.exe"
TARGET = sys.argv[2] if len(sys.argv) > 2 else r"D:\dev\work"
ROUNDS = int(sys.argv[3]) if len(sys.argv) > 3 else 30


def send(proc, message):
    body = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode()
    proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    proc.stdin.flush()


def receive(proc):
    headers = {}
    while True:
        line = proc.stdout.readline()
        if not line:
            raise AssertionError("owc-exec closed stdout (crashed?)")
        if line == b"\r\n":
            break
        name, value = line.decode("ascii").split(":", 1)
        headers[name.lower()] = value.strip()
    body = proc.stdout.read(int(headers["content-length"]))
    return json.loads(body)


def request(proc, request_id, method, params=None):
    send(proc, {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
    while True:
        message = receive(proc)
        if message.get("id") == request_id:
            return message


def main():
    proc = subprocess.Popen([CORE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    rid = 0

    def rpc(method, params=None):
        nonlocal rid
        rid += 1
        return request(proc, rid, method, params)

    r = rpc("core.ping")
    assert "result" in r, r
    r = rpc("session.configure", {
        "sessionId": "stress",
        "cwd": TARGET,
        "sandbox": {"enabled": True, "network": "allow", "allowPaths": []},
    })
    assert "result" in r, r
    print("capability:", r["result"].get("sandboxCapability"), r["result"].get("sandboxReason"))

    for n in range(ROUNDS):
        r = rpc("fs.glob", {"sessionId": "stress", "path": ".", "pattern": "**/*"})
        assert "result" in r, r
        paths = r["result"]["paths"]
        r = rpc("fs.grep", {"sessionId": "stress", "path": ".", "pattern": "def|import|class"})
        assert "result" in r, r
        for p in paths[:8]:
            r = rpc("fs.read", {"sessionId": "stress", "path": p})
            assert "result" in r or "error" in r, r
        r = rpc("exec.run", {
            "sessionId": "stress",
            "command": "Get-ChildItem | Select-Object -First 5 Name",
            "timeoutMs": 30000,
        })
        assert "result" in r or "error" in r, r
        r = rpc("job.start", {
            "sessionId": "stress",
            "kind": "search",
            "pattern": "agent",
            "root": ".",
        })
        if "result" in r:
            job_id = r["result"]["jobId"]
            r = rpc("job.status", {"sessionId": "stress", "jobId": job_id})
            r = rpc("job.output", {"sessionId": "stress", "jobId": job_id, "afterSeq": 0})
            rpc("job.cancel", {"sessionId": "stress", "jobId": job_id})
        print(f"round {n + 1}/{ROUNDS} ok, pid alive: {proc.poll() is None}")

    rpc("session.cleanup", {"sessionId": "stress"})
    proc.stdin.close()
    rc = proc.wait(timeout=10)
    err = proc.stderr.read().decode(errors="replace")
    print("exit code:", rc)
    if err:
        print("stderr:", err[-2000:])
    if rc != 0:
        print("FAILED: non-zero exit")
        sys.exit(1)
    print("PASS: no crash")


if __name__ == "__main__":
    main()
