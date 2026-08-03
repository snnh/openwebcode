#!/usr/bin/env python3
"""Protocol fixture for the overlay.* RPC family (four methods).

Contract cases (capability reporting, unknown-field rejection, path-form and
root-bound validation, platform gating) run everywhere against synthetic
POSIX paths: overlay paths are Linux-absolute by contract, so the lexical
gates are platform-independent.  The real mount / checkpoint / restore /
unmount lifecycle needs Linux with either root (kernel overlay mount) or
fuse-overlayfs on PATH; anywhere else the functional section is skipped and
the unsupported-platform error is asserted instead.
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


def assert_error(response, code, needle=None):
    error = response.get("error")
    assert error is not None, response
    assert error["code"] == code, response
    if needle:
        assert needle in error["message"], response


def main():
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


if __name__ == "__main__":
    main()
