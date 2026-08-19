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


def main_bindlink():
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

        # The backing ACL grant makes the bound tree reachable for
        # AppContainer-sandboxed processes too; the e2e covers both
        # enforcement modes.
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
            run_bind_link_e2e(proc, workspace, backing, virt, sandbox)
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


def run_bind_link_e2e(proc, workspace, backing, virt, base_sandbox):
    marker = os.path.join(backing, "hello.txt")
    with open(marker, "w", encoding="utf-8") as stored:
        stored.write("bind-link-ok")

    # Both enforcement modes must expose the bound tree to a sandboxed child;
    # the appcontainer mode relies on the backing-path ACL grant.
    request_id = 20
    for mode in ("appcontainer", "jobobject"):
        sandbox = {**base_sandbox, "mode": mode,
                   "bindLinks": [{"virtPath": virt, "backingPath": backing, "readOnly": True}]}
        response = configure(proc, request_id, workspace, sandbox)
        request_id += 1
        assert "result" in response, response

        # The backing tree is visible through the virt path for plain processes.
        via_virt = os.path.join(virt, "hello.txt")
        assert os.path.exists(via_virt), virt

        # Core fs primitives follow the controlled bind point as well (this is
        # the fs_win reparse/canonical-path interaction the exemption list covers).
        request(proc, request_id, "fs.read", {"sessionId": "bind", "path": via_virt})
        response, _ = collect_until_response(proc, request_id)
        request_id += 1
        assert "result" in response, response
        assert "bind-link-ok" in response["result"]["content"], response

        # A sandboxed child process reads through the virt path transparently.
        request(proc, request_id, "exec.run", {
            "sessionId": "bind",
            "execId": f"bind-read-{mode}",
            "cmd": f'type "{via_virt}"',
            "cwd": workspace,
            "timeoutMs": 10000,
        })
        response, notifications = collect_until_response(proc, request_id)
        request_id += 1
        assert "result" in response, response
        assert response["result"]["exitCode"] == 0, response
        output = "".join(
            __import__("base64").b64decode(note["params"]["data"]).decode("utf-8", "replace")
            for note in notifications
            if note.get("method") == "exec.output"
        )
        assert "bind-link-ok" in output, output

        # A read-only link refuses sandboxed writes through the virt path.
        blocked = os.path.join(virt, "blocked.txt")
        request(proc, request_id, "exec.run", {
            "sessionId": "bind",
            "execId": f"bind-write-{mode}",
            "cmd": f'echo nope>"{blocked}"',
            "cwd": workspace,
            "timeoutMs": 10000,
        })
        response, _ = collect_until_response(proc, request_id)
        request_id += 1
        assert "result" in response, response
        assert response["result"]["exitCode"] != 0, response
        assert not os.path.exists(os.path.join(backing, "blocked.txt"))

        # session.cleanup removes the link; the virt path stops resolving.
        request(proc, request_id, "session.cleanup", {"sessionId": "bind"})
        response, _ = collect_until_response(proc, request_id)
        request_id += 1
        assert "result" in response, response
        assert not os.path.exists(via_virt), via_virt


# --- overlay.* RPC family (absorbed from test_overlay.py) ---
#
# Contract cases (capability reporting, unknown-field rejection, path-form and
# root-bound validation, platform gating) run everywhere against synthetic
# POSIX paths: overlay paths are Linux-absolute by contract, so the lexical
# gates are platform-independent.  The real mount / checkpoint / restore /
# unmount lifecycle needs Linux with either root (kernel overlay mount) or
# fuse-overlayfs on PATH; anywhere else the functional section is skipped and
# the unsupported-platform error is asserted instead.


def main_overlay():
    executable = sys.argv[1]
    proc = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        request(proc, 1, "core.ping")
        response, _ = collect_until_response(proc, 1)
        assert "result" in response, response
        overlay = response["result"]["features"].get("overlay")
        assert isinstance(overlay, dict), response["result"]["features"]
        assert set(overlay) == {"supported", "fuseOverlayfs", "kernelMount"}, overlay
        assert all(isinstance(value, bool) for value in overlay.values()), overlay
        if os.name == "nt":
            assert overlay == {"supported": False, "fuseOverlayfs": False, "kernelMount": False}, overlay
        overlay_supported = overlay["supported"] and sys.platform.startswith("linux")

        # Synthetic POSIX paths: lexical gates are platform-independent.
        root = "/tmp/owc-overlay-contract"
        lower = "/tmp/owc-overlay-contract-lower"
        mount_params = {"stateRoot": root, "lower": lower, "upper": root + "/upper", "work": root + "/work", "merged": root + "/merged"}
        checkpoint_params = {"stateRoot": root, "upper": root + "/upper", "dest": root + "/snap-1"}
        restore_params = {**mount_params, "sourceUpper": root + "/snap-1"}
        unmount_params = {"stateRoot": root, "merged": root + "/merged"}

        # Unknown fields are rejected on every overlay method.
        for bad_id, method, params in [
            (2, "overlay.mount", {**mount_params, "bogus": 1}),
            (3, "overlay.checkpoint", {**checkpoint_params, "bogus": 1}),
            (4, "overlay.restore", {**restore_params, "bogus": 1}),
            (5, "overlay.unmount", {**unmount_params, "bogus": 1}),
        ]:
            request(proc, bad_id, method, params)
            response, _ = collect_until_response(proc, bad_id)
            assert_error(response, -32602, "unknown fields")

        # Missing required paths are rejected.
        request(proc, 6, "overlay.mount", {"stateRoot": root})
        response, _ = collect_until_response(proc, 6)
        assert_error(response, -32602)

        # Relative paths, dot components and backslashes are rejected (all
        # methods share the same form gate; exercise each gate once).
        for bad_id, method, params in [
            (7, "overlay.mount", {**mount_params, "upper": "relative/upper"}),
            (8, "overlay.mount", {**mount_params, "upper": root + "/../escape"}),
            (9, "overlay.checkpoint", {**checkpoint_params, "dest": root + "/a/../b"}),
            (10, "overlay.restore", {**restore_params, "sourceUpper": "../escape"}),
            (11, "overlay.unmount", {"stateRoot": root, "merged": root + "/."}),
            (12, "overlay.mount", {**mount_params, "stateRoot": root + "/.."}),
            (13, "overlay.mount", {**mount_params, "merged": root + "\\merged"}),
        ]:
            request(proc, bad_id, method, params)
            response, _ = collect_until_response(proc, bad_id)
            assert_error(response, -32602)

        # Paths outside stateRoot are denied (root-bound), not merely invalid.
        outside = lower + "/outside"
        for bad_id, method, params in [
            (14, "overlay.mount", {**mount_params, "merged": outside}),
            (15, "overlay.checkpoint", {**checkpoint_params, "dest": outside}),
            (16, "overlay.restore", {**restore_params, "sourceUpper": outside}),
            (17, "overlay.unmount", {"stateRoot": root, "merged": outside}),
            (18, "overlay.mount", {**mount_params, "upper": root}),
        ]:
            request(proc, bad_id, method, params)
            response, _ = collect_until_response(proc, bad_id)
            assert_error(response, -32002, "stateRoot")

        # merged must differ from lower; sourceUpper must differ from upper.
        request(proc, 19, "overlay.mount", {**mount_params, "lower": mount_params["merged"]})
        response, _ = collect_until_response(proc, 19)
        assert_error(response, -32602, "lower")
        request(proc, 20, "overlay.restore", {**restore_params, "sourceUpper": mount_params["upper"]})
        response, _ = collect_until_response(proc, 20)
        assert_error(response, -32602, "sourceUpper")

        if not overlay_supported:
            # Well-formed requests fail with the stable unsupported error.
            request(proc, 21, "overlay.mount", mount_params)
            response, _ = collect_until_response(proc, 21)
            assert_error(response, -32000, "not supported")
            request(proc, 22, "overlay.unmount", unmount_params)
            response, _ = collect_until_response(proc, 22)
            assert_error(response, -32000, "not supported")
            print("SKIP: overlay mount mechanism unavailable; lifecycle e2e not run", file=sys.stderr)
        else:
            run_overlay_lifecycle(proc)

        request(proc, 99, "core.shutdown")
        response, _ = collect_until_response(proc, 99)
        assert response["result"]["ok"] is True, response
        proc.wait(timeout=10)
        print("test_overlay.py: ok")
    finally:
        if proc.poll() is None:
            proc.kill()


def run_overlay_lifecycle(proc):
    state_root = tempfile.mkdtemp(prefix="owc-overlay-state-")
    lower = tempfile.mkdtemp(prefix="owc-overlay-lower-")
    upper = os.path.join(state_root, "upper")
    work = os.path.join(state_root, "work")
    merged = os.path.join(state_root, "merged")
    dest = os.path.join(state_root, "snap-1")
    mount_params = {"stateRoot": state_root, "lower": lower, "upper": upper, "work": work, "merged": merged}
    try:
        with open(os.path.join(lower, "base.txt"), "w", encoding="utf-8") as stored:
            stored.write("base")

        request(proc, 30, "overlay.mount", mount_params)
        response, _ = collect_until_response(proc, 30)
        assert "result" in response, response
        assert response["result"]["ok"] is True, response
        assert response["result"]["method"] in ("kernel", "fuse"), response

        # The lower layer is visible through the merged view.
        assert os.path.exists(os.path.join(merged, "base.txt"))

        # Writes land in the upper layer, not in lower.
        with open(os.path.join(merged, "change.txt"), "w", encoding="utf-8") as stored:
            stored.write("change")
        assert os.path.exists(os.path.join(upper, "change.txt"))
        assert not os.path.exists(os.path.join(lower, "change.txt"))

        # Checkpoint copies the upper layer into a fresh dest.
        request(proc, 31, "overlay.checkpoint", {"stateRoot": state_root, "upper": upper, "dest": dest})
        response, _ = collect_until_response(proc, 31)
        assert "result" in response, response
        assert response["result"]["files"] >= 1, response
        with open(os.path.join(dest, "change.txt"), "r", encoding="utf-8") as stored:
            assert stored.read() == "change"

        # More divergence after the checkpoint.
        with open(os.path.join(merged, "after.txt"), "w", encoding="utf-8") as stored:
            stored.write("after")

        # Restore rejects while a job is running (-32005 conflict).
        request(proc, 32, "session.configure", {"sessionId": "overlay", "cwd": state_root, "sandbox": {"enabled": False}})
        response, _ = collect_until_response(proc, 32)
        assert "result" in response, response
        request(proc, 33, "job.start", {"sessionId": "overlay", "jobId": "slow", "kind": "exec", "cmd": "sleep 30", "cwd": state_root, "timeoutMs": 60000})
        response, _ = collect_until_response(proc, 33)
        assert response.get("result", {}).get("state") == "running", response
        request(proc, 34, "overlay.restore", {**mount_params, "sourceUpper": dest})
        response, _ = collect_until_response(proc, 34)
        assert_error(response, -32005, "running jobs")
        request(proc, 35, "job.cancel", {"sessionId": "overlay", "jobId": "slow"})
        collect_until_response(proc, 35)
        for _ in range(100):
            request(proc, 351, "job.status", {"sessionId": "overlay", "jobId": "slow"})
            response, _ = collect_until_response(proc, 351)
            if response.get("result", {}).get("state") != "running":
                break
            time.sleep(0.1)
        assert response["result"]["state"] != "running", response

        # Restore rolls the merged view back to the checkpoint.
        request(proc, 36, "overlay.restore", {**mount_params, "sourceUpper": dest})
        response, _ = collect_until_response(proc, 36)
        assert "result" in response, response
        assert os.path.exists(os.path.join(merged, "change.txt")), os.listdir(merged)
        assert not os.path.exists(os.path.join(merged, "after.txt")), os.listdir(merged)
        assert os.path.exists(os.path.join(merged, "base.txt")), os.listdir(merged)

        # Unmount is idempotent: the second call succeeds as a no-op.
        for unmount_id in (37, 38):
            request(proc, unmount_id, "overlay.unmount", {"stateRoot": state_root, "merged": merged})
            response, _ = collect_until_response(proc, unmount_id)
            assert response.get("result", {}).get("ok") is True, response
        assert not os.path.exists(os.path.join(merged, "base.txt"))
    finally:
        # Best-effort cleanup in case a mount survived a failed assertion.
        subprocess.run(["fusermount3", "-u", merged], capture_output=True)
        subprocess.run(["umount", merged], capture_output=True)
        shutil.rmtree(state_root, ignore_errors=True)
        shutil.rmtree(lower, ignore_errors=True)


def main():
    main_bindlink()
    main_overlay()


if __name__ == "__main__":
    main()
