#!/usr/bin/env python3
"""Verify session_policy_path: absolute paths inside roots allowed, outside denied."""
import json
import os
import subprocess
import sys
import tempfile

CORE = sys.argv[1] if len(sys.argv) > 1 else r"D:\dev\openwebcode\build\Debug\owc-exec.exe"


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
    return json.loads(proc.stdout.read(int(headers["content-length"])))


def rpc(proc, request_id, method, params=None):
    send(proc, {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
    while True:
        message = receive(proc)
        if message.get("id") == request_id:
            return message


def main():
    workspace = tempfile.mkdtemp(prefix="owc-abspath-ws-")
    outside = tempfile.mkdtemp(prefix="owc-abspath-out-")
    with open(os.path.join(workspace, "hello.txt"), "w", encoding="utf-8") as f:
        f.write("hello\n")
    with open(os.path.join(outside, "secret.txt"), "w", encoding="utf-8") as f:
        f.write("secret\n")

    proc = subprocess.Popen([CORE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    rid = 0

    def call(method, params):
        nonlocal rid
        rid += 1
        return rpc(proc, rid, method, params)

    r = call("session.configure", {"sessionId": "abs", "cwd": workspace,
                                   "sandbox": {"enabled": False}})
    assert "result" in r, r

    def expect_ok(label, method, params):
        r = call(method, params)
        assert "result" in r, f"{label}: expected result, got {r}"
        print(f"OK   {label}")

    def expect_denied(label, method, params):
        r = call(method, params)
        assert "error" in r and r["error"]["code"] == -32002, f"{label}: expected -32002, got {r}"
        print(f"DENY {label}")

    ws_abs = os.path.join(workspace, "hello.txt")
    out_abs = os.path.join(outside, "secret.txt")

    # relative baseline
    expect_ok("relative read", "fs.read", {"sessionId": "abs", "path": "hello.txt"})
    # absolute inside workspace (native form with backslashes on Windows)
    expect_ok("absolute read inside", "fs.read", {"sessionId": "abs", "path": ws_abs})
    # absolute with forward slashes
    expect_ok("absolute read inside (fwd)", "fs.read",
              {"sessionId": "abs", "path": ws_abs.replace(os.sep, "/")})
    # absolute with dot components inside workspace
    expect_ok("absolute read with /./", "fs.read",
              {"sessionId": "abs", "path": os.path.join(workspace, ".", "hello.txt")})
    # absolute with /../ inside: core canonicalizes in C (model need not care)
    expect_ok("absolute read with /../ inside", "fs.read",
              {"sessionId": "abs", "path": os.path.join(workspace, "sub", "..", "hello.txt")})
    # glob/list/stat/hash on absolute inside
    expect_ok("absolute glob inside", "fs.glob",
              {"sessionId": "abs", "path": workspace, "pattern": "*.txt"})
    expect_ok("absolute stat inside", "fs.stat", {"sessionId": "abs", "path": ws_abs})
    # absolute outside workspace -> denied
    expect_denied("absolute read outside", "fs.read", {"sessionId": "abs", "path": out_abs})
    # absolute with /../ escaping workspace -> denied
    expect_denied("absolute read /../ escape", "fs.read",
                  {"sessionId": "abs", "path": os.path.join(workspace, "..", os.path.basename(outside), "secret.txt")})
    # relative with .. still denied
    expect_denied("relative .. read", "fs.read", {"sessionId": "abs", "path": "../x.txt"})
    # absolute write inside workspace allowed; outside denied
    expect_ok("absolute write inside", "fs.write",
              {"sessionId": "abs", "path": os.path.join(workspace, "new.txt"), "content": "x"})
    expect_denied("absolute write outside", "fs.write",
                  {"sessionId": "abs", "path": os.path.join(outside, "new.txt"), "content": "x"})
    # UNC rejected (cannot be inside roots anyway)
    expect_denied("UNC read", "fs.read", {"sessionId": "abs", "path": "\\\\server\\share\\x"})

    # path.normalize: canonical form + policy verdict (no IO)
    def norm_seps(p):
        return p.replace("\\", "/").lower()

    r = call("path.normalize", {"sessionId": "abs", "path": "hello.txt"})
    assert "result" in r and r["result"]["allowed"] is True, r
    assert norm_seps(r["result"]["path"]) == norm_seps(ws_abs), r
    assert norm_seps(r["result"]["root"]) == norm_seps(workspace), r
    print("OK   normalize relative")

    r = call("path.normalize", {"sessionId": "abs",
                                "path": os.path.join(workspace, "sub", "..", "hello.txt")})
    assert "result" in r and r["result"]["allowed"] is True, r
    assert norm_seps(r["result"]["path"]) == norm_seps(ws_abs), r
    print("OK   normalize absolute with /../ inside")

    r = call("path.normalize", {"sessionId": "abs", "path": out_abs})
    assert "result" in r and r["result"]["allowed"] is False and "reason" in r["result"], r
    assert norm_seps(r["result"]["path"]) == norm_seps(out_abs), r
    print("OK   normalize outside -> allowed=false with canonical path")

    # purpose=write vs read: writeRoots narrower than readRoots
    subdir = os.path.join(workspace, "wr")
    os.makedirs(subdir, exist_ok=True)
    r = call("session.configure", {"sessionId": "abs2", "cwd": workspace,
                                   "sandbox": {"enabled": False,
                                               "readRoots": [workspace],
                                               "writeRoots": [subdir]}})
    assert "result" in r, r
    r = call("path.normalize", {"sessionId": "abs2", "path": "hello.txt", "purpose": "read"})
    assert "result" in r and r["result"]["allowed"] is True, r
    print("OK   normalize purpose=read allowed under readRoots")
    r = call("path.normalize", {"sessionId": "abs2", "path": "hello.txt", "purpose": "write"})
    assert "result" in r and r["result"]["allowed"] is False, r
    print("OK   normalize purpose=write denied outside writeRoots")
    r = call("path.normalize", {"sessionId": "abs2", "path": os.path.join("wr", "x.txt"), "purpose": "write"})
    assert "result" in r and r["result"]["allowed"] is True, r
    print("OK   normalize purpose=write allowed inside writeRoots")

    # unnormalizable / invalid forms -> -32602
    def expect_invalid(label, params):
        r = call("path.normalize", params)
        assert "error" in r and r["error"]["code"] == -32602, f"{label}: expected -32602, got {r}"
        print(f"DENY {label}")

    expect_invalid("normalize relative ..", {"sessionId": "abs", "path": "../x.txt"})
    expect_invalid("normalize UNC", {"sessionId": "abs", "path": "\\\\server\\share\\x"})
    expect_invalid("normalize bad purpose", {"sessionId": "abs", "path": "hello.txt", "purpose": "execute"})
    expect_invalid("normalize unknown field", {"sessionId": "abs", "path": "hello.txt", "extra": 1})
    expect_invalid("normalize unknown session", {"sessionId": "nope", "path": "hello.txt"})

    # core.ping advertises the capability
    r = call("core.ping", {})
    assert r["result"]["features"]["pathNormalize"] is True, r
    print("OK   core.ping features.pathNormalize")

    call("session.cleanup", {"sessionId": "abs2"})
    call("session.cleanup", {"sessionId": "abs"})
    proc.stdin.close()
    rc = proc.wait(timeout=10)
    assert rc == 0, f"core exited with {rc}"
    print("PASS: absolute path policy behaves correctly")


if __name__ == "__main__":
    main()
