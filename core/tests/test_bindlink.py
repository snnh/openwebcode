#!/usr/bin/env python3
"""session.configure sandbox.bindLinks protocol tests.

Parse/validation cases run everywhere.  The real bind-link end-to-end case
needs Windows with the Bind Link API (bindlink.dll or bindfltapi.dll) and an
elevated process (CreateBindLink requires Administrator privileges); anywhere
else it is skipped, and the unsupported API path is asserted instead.
"""
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


def configure(proc, request_id, cwd, sandbox=None, extra=None):
    params = {"sessionId": "bind", "cwd": cwd}
    if sandbox is not None:
        params["sandbox"] = sandbox
    if extra:
        params.update(extra)
    request(proc, request_id, "session.configure", params)
    return collect_until_response(proc, request_id)[0]


def assert_error(response, code, needle=None):
    error = response.get("error")
    assert error is not None, response
    assert error["code"] == code, response
    if needle:
        assert needle in error["message"], response


def is_admin():
    if os.name != "nt":
        return False
    import ctypes

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def main():
    executable = sys.argv[1]
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    workspace = tempfile.mkdtemp(prefix="owc-bindlink-workspace-")
    backing = tempfile.mkdtemp(prefix="owc-bindlink-backing-")
    link_created = False
    try:
        request(proc, 1, "core.ping")
        response, _ = collect_until_response(proc, 1)
        assert "result" in response, response
        features = response["result"]["features"]
        bind_feature = features.get("bindLink")
        assert bind_feature in (True, False), features

        virt = os.path.join(workspace, "bound")
        outside = os.path.join(backing, "elsewhere")
        sandbox = {"enabled": True, "network": "allow", "readRoots": [workspace], "writeRoots": [workspace]}

        # Unknown top-level field is rejected.
        response = configure(proc, 2, workspace, sandbox, extra={"bogus": 1})
        assert_error(response, -32602, "unknown fields")

        # Unknown bindLinks entry field is rejected.
        response = configure(proc, 3, workspace, {**sandbox, "bindLinks": [{"virtPath": virt, "backingPath": backing, "oops": 1}]})
        assert_error(response, -32602, "bindLinks")

        # bindLinks must be an array.
        response = configure(proc, 4, workspace, {**sandbox, "bindLinks": "nope"})
        assert_error(response, -32602, "bindLinks")

        # More than 16 entries are rejected.
        response = configure(proc, 5, workspace, {**sandbox, "bindLinks": [{"virtPath": virt, "backingPath": backing}] * 17})
        assert_error(response, -32602, "bindLinks")

        # Empty virtPath/backingPath are rejected.
        response = configure(proc, 6, workspace, {**sandbox, "bindLinks": [{"virtPath": "", "backingPath": backing}]})
        assert_error(response, -32602, "bindLinks")

        # readOnly must be a boolean.
        response = configure(proc, 7, workspace, {**sandbox, "bindLinks": [{"virtPath": virt, "backingPath": backing, "readOnly": "yes"}]})
        assert_error(response, -32602, "readOnly")

        # virtPath outside the session write roots is rejected (privilege check).
        response = configure(proc, 8, workspace, {**sandbox, "bindLinks": [{"virtPath": outside, "backingPath": backing}]})
        assert_error(response, -32602, "virtPath")

        # backingPath must be an existing directory.
        response = configure(proc, 9, workspace, {**sandbox, "bindLinks": [{"virtPath": virt, "backingPath": os.path.join(backing, "missing")}]})
        assert_error(response, -32602, "backingPath")

        # Failed configurations must not leave a half-configured session: a
        # plain configure still succeeds afterwards.
        response = configure(proc, 10, workspace, sandbox)
        assert "result" in response, response

        valid = {**sandbox, "bindLinks": [{"virtPath": virt, "backingPath": backing, "readOnly": True}]}
        if not bind_feature:
            response = configure(proc, 11, workspace, valid)
            assert_error(response, -32000, "bind_link_unavailable")
            print("SKIP: bind link API not present (features.bindLink=false); e2e not run", file=sys.stderr)
        elif not is_admin():
            response = configure(proc, 11, workspace, valid)
            assert_error(response, -32000, "bind_link_unavailable")
            print("SKIP: not elevated; CreateBindLink requires Administrator, e2e not run", file=sys.stderr)
        else:
            run_bind_link_e2e(proc, workspace, backing, virt, valid)
            link_created = False  # e2e cleans up its own link
        print("test_bindlink.py: ok")
    finally:
        if link_created:
            request(proc, 90, "session.cleanup", {"sessionId": "bind"})
            try:
                collect_until_response(proc, 90)
            except Exception:
                pass
        try:
            request(proc, 99, "core.shutdown")
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(workspace, ignore_errors=True)
        shutil.rmtree(backing, ignore_errors=True)


def run_bind_link_e2e(proc, workspace, backing, virt, sandbox):
    marker = os.path.join(backing, "hello.txt")
    with open(marker, "w", encoding="utf-8") as stored:
        stored.write("bind-link-ok")

    response = configure(proc, 20, workspace, sandbox)
    assert "result" in response, response

    # The backing tree is visible through the virt path for plain processes.
    assert os.path.exists(os.path.join(virt, "hello.txt")), virt

    # Core fs primitives follow the controlled bind point as well (this is the
    # fs_win reparse/canonical-path interaction the exemption list covers).
    via_virt = os.path.join(virt, "hello.txt")
    request(proc, 21, "fs.read", {"sessionId": "bind", "path": via_virt})
    response, _ = collect_until_response(proc, 21)
    assert "result" in response, response
    assert "bind-link-ok" in response["result"]["content"], response

    # A sandboxed child process reads through the virt path transparently.
    request(proc, 22, "exec.run", {
        "sessionId": "bind",
        "execId": "bind-read",
        "cmd": f'type "{via_virt}"',
        "cwd": workspace,
        "timeoutMs": 10000,
    })
    response, notifications = collect_until_response(proc, 22)
    assert "result" in response, response
    assert response["result"]["exitCode"] == 0, response
    output = "".join(
        __import__("base64").b64decode(note["params"]["data"]).decode("utf-8", "replace")
        for note in notifications
        if note.get("method") == "exec.output"
    )
    assert "bind-link-ok" in output, output

    # session.cleanup removes the link; the virt path stops resolving.
    request(proc, 23, "session.cleanup", {"sessionId": "bind"})
    response, _ = collect_until_response(proc, 23)
    assert "result" in response, response
    assert not os.path.exists(via_virt), via_virt


if __name__ == "__main__":
    main()
