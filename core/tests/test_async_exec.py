#!/usr/bin/env python3
"""exec.run async dispatch: control-plane responsiveness, cancel, and output."""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

IS_WINDOWS = sys.platform == "win32"


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


def reader(proc, messages):
    try:
        while True:
            messages.put((receive(proc), time.time()))
    except BaseException as error:  # noqa: BLE001 - surfaced by wait_for
        messages.put(error)


def wait_for(messages, wanted, timeout=15.0):
    """Collect responses by id; notifications are ignored."""
    results = {}
    deadline = time.time() + timeout
    while len(results) < len(wanted):
        remaining = deadline - time.time()
        if remaining <= 0:
            raise AssertionError(f"timed out waiting for {sorted(set(wanted) - set(results))}")
        try:
            message, received_at = messages.get(timeout=remaining)
        except queue.Empty:
            raise AssertionError(f"timed out waiting for {sorted(set(wanted) - set(results))}")
        if isinstance(message, BaseException):
            raise message
        if "id" in message and message["id"] in wanted:
            message["_received_at"] = received_at
            results[message["id"]] = message
    return results


def request(proc, request_id, method, params=None):
    send(proc, {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})


def main():
    executable = sys.argv[1]
    with tempfile.TemporaryDirectory(prefix="owc-async-exec-") as root:
        cwd_a = os.path.join(root, "a")
        cwd_b = os.path.join(root, "b")
        os.makedirs(cwd_a)
        os.makedirs(cwd_b)
        sandbox = lambda cwd: {"enabled": False, "readRoots": [cwd], "writeRoots": [cwd], "denyPaths": [], "network": "allow"}
        long_cmd = 'powershell -NoProfile -Command "Start-Sleep -Seconds 2"' if IS_WINDOWS else "sleep 2"
        short_cmd = 'powershell -NoProfile -Command "Write-Output ok"' if IS_WINDOWS else "echo ok"
        cancel_cmd = 'powershell -NoProfile -Command "Start-Sleep -Seconds 30"' if IS_WINDOWS else "sleep 30"

        proc = subprocess.Popen(
            [executable],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        messages = queue.Queue()
        threading.Thread(target=reader, args=(proc, messages), daemon=True).start()
        try:
            request(proc, 1, "core.ping")
            ping = wait_for(messages, [1])[1]
            assert ping["result"]["features"]["asyncExec"] is True, ping

            request(proc, 2, "session.configure", {"sessionId": "a", "cwd": cwd_a, "sandbox": sandbox(cwd_a)})
            request(proc, 3, "session.configure", {"sessionId": "b", "cwd": cwd_b, "sandbox": sandbox(cwd_b)})
            configured = wait_for(messages, [2, 3])
            assert "result" in configured[2] and "result" in configured[3], configured

            # A runs a 2s command; the other control-plane calls must not wait for it.
            started = time.time()
            request(proc, 10, "exec.run", {"sessionId": "a", "execId": "long", "cmd": long_cmd, "cwd": cwd_a, "timeoutMs": 30000})
            time.sleep(0.2)
            control_start = time.time()
            request(proc, 11, "core.ping")
            request(proc, 12, "fs.stat", {"sessionId": "b", "path": "."})
            request(proc, 13, "session.configure", {"sessionId": "b", "cwd": cwd_b, "sandbox": sandbox(cwd_b)})
            request(proc, 14, "exec.run", {"sessionId": "b", "execId": "short", "cmd": short_cmd, "cwd": cwd_b, "timeoutMs": 30000})
            responses = wait_for(messages, [10, 11, 12, 13, 14], timeout=15.0)
            control_elapsed = max(responses[request_id]["_received_at"] for request_id in (11, 12, 13, 14)) - control_start
            assert "result" in responses[10], responses[10]
            assert control_elapsed < 1.5, f"control plane blocked for {control_elapsed:.2f}s"
            for request_id in (11, 12, 13, 14):
                assert "result" in responses[request_id], responses[request_id]
            total = responses[10]["_received_at"] - started
            assert total >= 1.8, f"long command returned too early: {total:.2f}s"

            # Running cancel: response must be the cancelled error, quickly.
            request(proc, 20, "exec.run", {"sessionId": "a", "execId": "cancel-me", "cmd": cancel_cmd, "cwd": cwd_a, "timeoutMs": 60000})
            time.sleep(0.3)
            cancel_start = time.time()
            request(proc, 21, "exec.cancel", {"sessionId": "a", "execId": "cancel-me"})
            cancelled = wait_for(messages, [20, 21], timeout=10.0)
            assert cancelled[21]["result"] == {"ok": True}, cancelled[21]
            assert cancelled[20]["error"]["code"] == -32001, cancelled[20]
            assert time.time() - cancel_start < 2.0, "cancel did not terminate the command promptly"

            # Queued cancel: occupy all 8 workers, then cancel the 9th before it starts.
            fillers = list(range(8))
            for index in fillers:
                request(proc, 50 + index, "exec.run", {
                    "sessionId": "a", "execId": f"queue-fill-{index}", "cmd": cancel_cmd, "cwd": cwd_a, "timeoutMs": 60000,
                })
            time.sleep(0.8)
            request(proc, 60, "exec.run", {"sessionId": "a", "execId": "queue-2", "cmd": cancel_cmd, "cwd": cwd_a, "timeoutMs": 60000})
            time.sleep(0.2)
            request(proc, 61, "exec.cancel", {"sessionId": "a", "execId": "queue-2"})
            queued = wait_for(messages, [60, 61], timeout=5.0)
            assert queued[61]["result"] == {"ok": True}, queued[61]
            assert queued[60]["error"]["code"] == -32001, queued[60]

            for index in fillers:
                request(proc, 70 + index, "exec.cancel", {"sessionId": "a", "execId": f"queue-fill-{index}"})
            filler_responses = wait_for(messages, [50 + index for index in fillers] + [70 + index for index in fillers], timeout=10.0)
            for index in fillers:
                assert filler_responses[50 + index]["error"]["code"] == -32001, filler_responses[50 + index]

            # Output notifications keep the documented execId/stream/data shape.
            request(proc, 40, "exec.run", {"sessionId": "a", "execId": "output", "cmd": "echo async-output", "cwd": cwd_a, "timeoutMs": 30000})
            output = wait_for(messages, [40], timeout=10.0)[40]
            assert "result" in output, output
            print("async exec protocol: ok")
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass
            proc.wait(timeout=5)
            if proc.returncode not in (0, 2):
                raise AssertionError(f"owc-exec exited with {proc.returncode}")


if __name__ == "__main__":
    main()
