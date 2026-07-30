#!/usr/bin/env python3
"""Minimal repro: configure + fs.grep that crashed owc-exec."""
import json
import subprocess
import sys

CORE = sys.argv[1] if len(sys.argv) > 1 else r"D:\dev\openwebcode\build\Debug\owc-exec.exe"
TARGET = sys.argv[2] if len(sys.argv) > 2 else r"D:\dev\work"


def send(proc, message):
    body = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode()
    proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    proc.stdin.flush()


def receive(proc):
    headers = {}
    while True:
        line = proc.stdout.readline()
        if not line:
            return None
        if line == b"\r\n":
            break
        name, value = line.decode("ascii").split(":", 1)
        headers[name.lower()] = value.strip()
    body = proc.stdout.read(int(headers["content-length"]))
    return json.loads(body)


def rpc(proc, request_id, method, params=None):
    send(proc, {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
    return receive(proc)


def main():
    proc = subprocess.Popen([CORE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    r = rpc(proc, 1, "core.ping")
    print("ping:", r is not None)
    r = rpc(proc, 2, "session.configure", {
        "sessionId": "repro", "cwd": TARGET,
        "sandbox": {"enabled": True, "network": "allow", "allowPaths": []},
    })
    print("configure:", json.dumps(r)[:200] if r else None)
    r = rpc(proc, 3, "fs.grep", {"sessionId": "repro", "path": ".", "pattern": "def|import|class"})
    print("grep:", json.dumps(r)[:200] if r else "CLOSED/CRASH")
    if r is None:
        proc.wait(timeout=30)
        print("exit code:", proc.returncode)
        err = proc.stderr.read().decode(errors="replace")
        print("stderr:", err[-3000:])
        sys.exit(1)
    rpc(proc, 4, "session.cleanup", {"sessionId": "repro"})
    proc.stdin.close()
    proc.wait(timeout=10)
    print("exit code:", proc.returncode)
    print("PASS")


if __name__ == "__main__":
    main()
