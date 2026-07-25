#!/usr/bin/env python3
"""index.scan job contract tests.

Covers the 0.4.0 Phase 2 indexing primitive: glob include/exclude rules,
node/depth/byte/time budgets, cancellation, no-follow behaviour, result
determinism, hash correctness, and bounded job output pagination.  Runs on
Windows and Linux; platform-specific no-follow coverage skips gracefully when
link creation is not permitted.
"""
import atexit
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time


def send(p, i, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}, ensure_ascii=False, separators=(",", ":")).encode()
    p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    p.stdin.flush()
    while True:
        headers = {}
        while True:
            line = p.stdout.readline()
            assert line, "owc-exec closed stdout"
            if line == b"\r\n":
                break
            k, v = line.decode().split(":", 1)
            headers[k.lower()] = v.strip()
        msg = json.loads(p.stdout.read(int(headers["content-length"])))
        if msg.get("id") == i:
            return msg


def wait_terminal(p, job_id, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = send(p, "status", "job.status", {"sessionId": "s", "jobId": job_id})["result"]
        if status["state"] != "running":
            return status
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not reach a terminal state")


def scan_output(p, job_id, page_limit=64):
    """Drain the JSONL manifest through the bounded job.output pagination."""
    chunks = []
    after = 0
    while True:
        page = send(p, "output", "job.output", {"sessionId": "s", "jobId": job_id, "afterSeq": after, "limit": page_limit})["result"]
        chunks.extend(page["chunks"])
        if page["nextSeq"] == after:
            break
        after = page["nextSeq"]
    text = b"".join(base64.b64decode(c["data"]) for c in chunks).decode("utf-8")
    lines = [json.loads(line) for line in text.splitlines()]
    summary = lines[-1]["summary"]
    return lines[:-1], summary


def run_scan(p, job_id, **params):
    request = {"sessionId": "s", "jobId": job_id, "kind": "index.scan", "cwd": CWD, "path": "."}
    request.update(params)
    response = send(p, "start", "job.start", request)
    assert "result" in response, response
    assert response["result"]["state"] == "running", response
    return wait_terminal(p, job_id)


def directory_link(link, target):
    try:
        if os.name == "nt":
            os.symlink(target, link, target_is_directory=True)
        else:
            os.symlink(target, link)
        return True
    except OSError:
        if os.name == "nt":
            return subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True).returncode == 0
        return False


CWD = None


def main():
    global CWD
    p = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def cleanup_process():
        if p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=5)
    atexit.register(cleanup_process)

    with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as outside:
        CWD = td
        root = pathlib.Path(td)
        (root / "src").mkdir()
        (root / "src" / "main.ts").write_bytes(b"export const main = 1;\n")
        (root / "src" / "util.ts").write_bytes(b"export const util = 2;\n")
        (root / "docs").mkdir()
        (root / "docs" / "guide.md").write_bytes(b"# guide\n")
        (root / "deep" / "one" / "two" / "three").mkdir(parents=True)
        (root / "deep" / "one" / "two" / "three" / "leaf.txt").write_bytes(b"leaf")
        (root / "denied").mkdir()
        (root / "denied" / "secret.txt").write_text("secret")
        big = root / "big"
        big.mkdir()
        for i in range(200):
            (big / f"file-{i:04}.txt").write_text(f"payload {i}")

        configured = send(p, 1, "session.configure", {"sessionId": "s", "cwd": td, "sandbox": {"enabled": True, "readRoots": [td], "writeRoots": [td], "denyPaths": [str(root / "denied")], "network": "allow"}})
        assert configured["result"]["sandboxCapability"] in {"advisory", "partial", "enforced"}, configured

        # Unknown fields and invalid budgets are rejected before a job starts.
        assert send(p, 2, "job.start", {"sessionId": "s", "jobId": "bad1", "kind": "index.scan", "cwd": td, "path": ".", "unexpected": True})["error"]["code"] == -32602
        assert send(p, 3, "job.start", {"sessionId": "s", "jobId": "bad2", "kind": "index.scan", "cwd": td})["error"]["code"] == -32602
        assert send(p, 4, "job.start", {"sessionId": "s", "jobId": "bad3", "kind": "index.scan", "cwd": td, "path": ".", "maxDepth": 65})["error"]["code"] == -32602
        assert send(p, 5, "job.start", {"sessionId": "s", "jobId": "bad4", "kind": "index.scan", "cwd": td, "path": ".", "maxNodes": 0})["error"]["code"] == -32602
        assert send(p, 6, "job.start", {"sessionId": "s", "jobId": "bad5", "kind": "index.scan", "cwd": td, "path": ".", "maxBytes": 0})["error"]["code"] == -32602
        assert send(p, 7, "job.start", {"sessionId": "s", "jobId": "bad6", "kind": "index.scan", "cwd": td, "path": ".", "maxMs": 600001})["error"]["code"] == -32602
        assert send(p, 8, "job.start", {"sessionId": "s", "jobId": "bad7", "kind": "index.scan", "cwd": td, "path": ".", "include": "src/*"})["error"]["code"] == -32602
        assert send(p, 9, "job.start", {"sessionId": "s", "jobId": "bad8", "kind": "index.scan", "cwd": td, "path": "denied"})["error"]["code"] == -32002

        # Full scan: deterministic order, SHA-256 per file, deny rules honoured.
        status = run_scan(p, "full")
        assert status["state"] == "completed", status
        entries, summary = scan_output(p, "full")
        paths = [e["path"] for e in entries]
        assert paths == sorted(paths), paths
        assert summary == {"entries": len(entries), "truncated": False, "reason": None, "hashTruncated": False}, summary
        assert "src/main.ts" in paths and "docs/guide.md" in paths and "deep/one/two/three/leaf.txt" in paths
        assert not any(path.startswith("denied") for path in paths), paths
        expected = hashlib.sha256(b"export const main = 1;\n").hexdigest()
        main_entry = next(e for e in entries if e["path"] == "src/main.ts")
        assert main_entry["sha256"] == expected, main_entry
        assert main_entry["size"] == len(b"export const main = 1;\n")
        assert isinstance(main_entry["modifiedMs"], int) and main_entry["modifiedMs"] > 0

        # Result determinism: a second scan emits byte-identical manifest lines
        # for unchanged content (paths, sizes, hashes; mtimes are stable too).
        status = run_scan(p, "full-again")
        assert status["state"] == "completed", status
        again, again_summary = scan_output(p, "full-again")
        assert again == entries, "two scans of an unchanged tree must agree"
        assert again_summary == summary

        # include/exclude globs follow fs.glob semantics.
        status = run_scan(p, "glob", include=["*.ts"], exclude=["src/util*"])
        assert status["state"] == "completed", status
        # Page size 1 forces multi-page output draining on two output lines.
        globbed, _ = scan_output(p, "glob", page_limit=1)
        assert [e["path"] for e in globbed] == ["src/main.ts"], globbed

        # Node budget truncates the walk and says why.
        status = run_scan(p, "nodes", maxNodes=5)
        assert status["state"] == "completed", status
        _, nodes_summary = scan_output(p, "nodes")
        assert nodes_summary["truncated"] is True and nodes_summary["reason"] == "nodes", nodes_summary

        # Depth budget truncates recursion without failing the scan.
        status = run_scan(p, "depth", maxDepth=1)
        assert status["state"] == "completed", status
        depth_entries, depth_summary = scan_output(p, "depth")
        assert depth_summary["truncated"] is True and depth_summary["reason"] == "depth", depth_summary
        assert "deep/one/two/three/leaf.txt" not in [e["path"] for e in depth_entries]

        # Byte budget bounds hashing, not listing: all files stay in the
        # manifest, later ones simply lack a digest.
        status = run_scan(p, "bytes", maxBytes=64)
        assert status["state"] == "completed", status
        byte_entries, byte_summary = scan_output(p, "bytes")
        assert byte_summary["hashTruncated"] is True, byte_summary
        assert byte_summary["truncated"] is False, byte_summary
        assert any("sha256" not in e for e in byte_entries)
        assert len(byte_entries) == len(entries)

        # Time budget stops the walk promptly on a larger tree.
        status = run_scan(p, "time", maxMs=1)
        assert status["state"] == "completed", status
        _, time_summary = scan_output(p, "time")
        assert time_summary["truncated"] is True and time_summary["reason"] == "time", time_summary

        # no-follow: links are never traversed, so the outside tree is invisible.
        link = root / "escape"
        if directory_link(link, pathlib.Path(outside)):
            (pathlib.Path(outside) / "outside.txt").write_text("outside")
            status = run_scan(p, "nofollow")
            assert status["state"] == "completed", status
            nofollow, _ = scan_output(p, "nofollow")
            assert not any("escape" in e["path"] for e in nofollow), nofollow
            assert not any(e["path"] == "outside.txt" for e in nofollow), nofollow

        # Single-directory enumeration cap (same 256-entry listing budget as
        # fs.scan): flagged as truncated with reason "list", scan continues.
        wide = root / "wide"
        wide.mkdir()
        for i in range(300):
            (wide / f"w-{i:04}.txt").write_text("w")
        status = run_scan(p, "list", path="wide")
        assert status["state"] == "completed", status
        list_entries, list_summary = scan_output(p, "list")
        assert list_summary["truncated"] is True and list_summary["reason"] == "list", list_summary
        assert len(list_entries) == 256, len(list_entries)

        # Cancellation: hashing a few thousand files cannot finish before the
        # cancel lands, so the terminal state must be cancelled.
        slow = root / "slow"
        slow.mkdir()
        for d in range(50):
            sub = slow / f"d{d:02}"
            sub.mkdir()
            for i in range(40):
                (sub / f"f{i:02}.txt").write_text(f"{d}/{i}")
        started = send(p, "start", "job.start", {"sessionId": "s", "jobId": "cancel-me", "kind": "index.scan", "cwd": td, "path": "."})
        assert started["result"]["state"] == "running", started
        cancelled = send(p, "cancel", "job.cancel", {"sessionId": "s", "jobId": "cancel-me"})["result"]
        assert cancelled == {"jobId": "cancel-me", "accepted": True}, cancelled
        assert wait_terminal(p, "cancel-me")["state"] == "cancelled"

        assert send(p, 99, "core.shutdown", {})["result"]["ok"] is True
    assert p.wait(timeout=5) == 0
    atexit.unregister(cleanup_process)


if __name__ == "__main__":
    main()
