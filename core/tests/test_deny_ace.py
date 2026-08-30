#!/usr/bin/env python3
"""Windows AppContainer denyPaths end-to-end tests.

The fs.* RPC layer has always enforced denyPaths textually; these cases pin
the command-layer enforcement: under AppContainer, each existing deny path
is stripped of the sandbox package SID's ACEs (the AppContainer package leg
of the access check is allow-only, so a missing allow - not a DENY ACE - is
what actually blocks), and a sandboxed command cannot read or write the
path even though the workspace write root would otherwise allow both.
Requires Windows with a working AppContainer probe (the same environments
the filtered e2e needs); other platforms and advisory/partial probes skip
honestly.
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
    return json.loads(proc.stdout.read(int(headers["content-length"])))


def request(proc, request_id, method, params=None):
    send(proc, {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})


def collect_until_response(proc, request_id):
    notifications = []
    while True:
        message = receive(proc)
        if message.get("id") == request_id:
            return message, notifications
        notifications.append(message)


def configure(proc, request_id, cwd, sandbox, session):
    request(proc, request_id, "session.configure",
            {"sessionId": session, "cwd": cwd, "sandbox": sandbox})
    return collect_until_response(proc, request_id)[0]


def exec_command(proc, request_id, session, cwd, cmd):
    request(proc, request_id, "exec.run",
            {"sessionId": session, "execId": f"e{request_id}", "cmd": cmd,
             "cwd": cwd, "timeoutMs": 30000})
    response, notifications = collect_until_response(proc, request_id)
    output = "".join(
        base64.b64decode(note["params"]["data"]).decode("utf-8", "replace")
        for note in notifications
        if note.get("method") == "exec.output"
    )
    return response, output


def main():
    executable = sys.argv[1]
    if sys.platform != "win32":
        print("SKIP: denyPaths DENY ACE e2e is Windows-only", file=sys.stderr)
        return
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    workspace = tempfile.mkdtemp(prefix="owc-deny-workspace-")
    try:
        secret = os.path.join(workspace, ".env")
        hooks_dir = os.path.join(workspace, ".owc")
        hooks = os.path.join(hooks_dir, "hooks.json")
        os.mkdir(hooks_dir)
        with open(secret, "w", encoding="utf-8") as stored:
            stored.write("SUPER_SECRET_TOKEN")
        with open(hooks, "w", encoding="utf-8") as stored:
            stored.write('{"hooks":[]}')
        with open(os.path.join(workspace, "ok.txt"), "w", encoding="utf-8") as stored:
            stored.write("plain-content")

        sandbox = {"enabled": True, "network": "allow",
                   "readRoots": [workspace], "writeRoots": [workspace],
                   "denyPaths": [secret, hooks]}
        response = configure(proc, 1, workspace, sandbox, "deny")
        assert "result" in response, response
        capability = response["result"]["sandboxCapability"]
        if capability != "enforced":
            print(f"SKIP: AppContainer is {capability} here "
                  f"({response['result'].get('sandboxReason', '')}); denyPaths e2e not applicable",
                  file=sys.stderr)
            return

        # Positive control: a non-deny file in the workspace reads fine.
        response, output = exec_command(proc, 2, "deny", workspace, 'type "ok.txt"')
        assert "result" in response and response["result"]["exitCode"] == 0, response
        assert "plain-content" in output, output

        # The DENY ACE blocks reading the deny file from the sandboxed
        # command even though the workspace write root allows reads.
        response, output = exec_command(proc, 3, "deny", workspace, 'type ".env"')
        assert "result" in response, response
        assert response["result"]["exitCode"] != 0, response
        assert "SUPER_SECRET_TOKEN" not in output, output

        # ... and writing the deny file (a hook overwrite is the classic
        # sandbox-escape vector).
        response, output = exec_command(proc, 4, "deny", workspace,
                                        'echo injected> ".owc\\hooks.json"')
        assert "result" in response, response
        assert response["result"]["exitCode"] != 0, (response, output)
        with open(hooks, "r", encoding="utf-8") as stored:
            assert stored.read() == '{"hooks":[]}'

        # The deny boundary outlives a single command: a file created by a
        # sandboxed command at a deny path location is DENY-ed from the next
        # command on (per-command profiles re-grant every run).
        dropped = os.path.join(workspace, "dropped.env")
        response, _ = exec_command(proc, 5, "deny", workspace, 'echo x> "dropped.env"')
        assert "result" in response and response["result"]["exitCode"] == 0, response
        response = configure(proc, 6, workspace,
                             {**sandbox, "denyPaths": [secret, hooks, dropped]},
                             "deny")
        assert "result" in response, response
        response, output = exec_command(proc, 7, "deny", workspace, 'type "dropped.env"')
        assert "result" in response, response
        assert response["result"]["exitCode"] != 0, (response, output)

        # Explicit jobobject compatibility mode keeps its documented
        # semantics: no filesystem isolation, denyPaths not enforced.
        response = configure(proc, 8, workspace, {**sandbox, "mode": "jobobject"}, "deny-jobobject")
        assert "result" in response, response
        assert response["result"]["sandboxCapability"] == "partial", response
        response, output = exec_command(proc, 9, "deny-jobobject", workspace, 'type ".env"')
        assert "result" in response and response["result"]["exitCode"] == 0, response
        assert "SUPER_SECRET_TOKEN" in output, output

        print("test_deny_ace.py: ok")
    finally:
        try:
            request(proc, 97, "session.cleanup", {"sessionId": "deny"})
            collect_until_response(proc, 97)
            request(proc, 98, "session.cleanup", {"sessionId": "deny-jobobject"})
            collect_until_response(proc, 98)
            request(proc, 99, "core.shutdown")
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    main()
