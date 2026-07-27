#!/usr/bin/env python3
"""grep / glob job contract tests.

Covers the 0.5.0 Phase 2c search primitives: job.start kind=grep and
kind=glob.  Verifies deterministic sorted output, content search
correctness, include/exclude filtering, node/depth/time budgets,
cancellation, no-follow behaviour, parallel grep (multiple workers find
all matches), and bounded job.output pagination.  Runs on Windows and
Linux; platform-specific no-follow coverage skips gracefully when link
creation is not permitted.
"""
import atexit
import base64
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


def wait_terminal(p, job_id, timeout=30, session_id="s"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = send(p, "status", "job.status", {"sessionId": session_id, "jobId": job_id})["result"]
        if status["state"] != "running":
            return status
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not reach a terminal state")


def search_output(p, job_id, page_limit=64):
    """Drain the JSONL output through the bounded job.output pagination."""
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


def run_search(p, job_id, kind, pattern, **params):
    request = {"sessionId": "s", "jobId": job_id, "kind": kind, "cwd": CWD, "path": ".", "pattern": pattern}
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
        (root / "src" / "main.ts").write_bytes(b"export const main = 1;\nconst beta = 2;\n")
        (root / "src" / "util.ts").write_bytes(b"export const util = 2;\nconst beta = 3;\n")
        (root / "docs").mkdir()
        (root / "docs" / "guide.md").write_bytes(b"# guide\nbeta reference\n")
        (root / "deep" / "one" / "two").mkdir(parents=True)
        (root / "deep" / "one" / "two" / "leaf.txt").write_bytes(b"leaf\nbeta deep\n")
        (root / "denied").mkdir()
        (root / "denied" / "secret.txt").write_text("secret beta")
        big = root / "many"
        big.mkdir()
        for i in range(50):
            (big / f"f{i:04}.ts").write_bytes(b"export const x = 1;\nconst beta = 2;\n")

        configured = send(p, 1, "session.configure", {"sessionId": "s", "cwd": td, "sandbox": {"enabled": True, "readRoots": [td], "writeRoots": [td], "denyPaths": [str(root / "denied")], "network": "allow"}})
        assert configured["result"]["sandboxCapability"] in {"advisory", "partial", "enforced"}, configured

        # Windows resolved-path deny roots are thread-scoped. Publishing a
        # second session's policy on the RPC thread must not make an already
        # snapshotted search worker inherit that policy and reject its own cwd.
        other_root = pathlib.Path(outside)
        (other_root / "probe.txt").write_text("probe")
        other = send(p, "configure-other", "session.configure", {
            "sessionId": "other",
            "cwd": outside,
            "sandbox": {
                "enabled": True,
                "readRoots": [outside],
                "writeRoots": [outside],
                "denyPaths": [td],
                "network": "allow",
            },
        })
        assert "result" in other, other
        assert send(p, "publish-other-policy", "fs.stat", {"sessionId": "other", "path": "."}).get("result", {}).get("type") == "directory"
        isolated = send(p, "start-policy-isolation", "job.start", {
            "sessionId": "s",
            "jobId": "policy-isolation",
            "kind": "glob",
            "cwd": td,
            "path": ".",
            "pattern": "*.ts",
        })
        assert isolated.get("result", {}).get("state") == "running", isolated
        assert wait_terminal(p, "policy-isolation")["state"] == "completed"

        # --- grep job: basic content search ---

        # Unknown fields and invalid budgets are rejected before a job starts.
        assert send(p, 2, "job.start", {"sessionId": "s", "jobId": "bad1", "kind": "grep", "cwd": td, "path": ".", "pattern": "beta", "unexpected": True})["error"]["code"] == -32602
        assert send(p, 3, "job.start", {"sessionId": "s", "jobId": "bad2", "kind": "grep", "cwd": td, "pattern": "beta"})["error"]["code"] == -32602
        assert send(p, 4, "job.start", {"sessionId": "s", "jobId": "bad3", "kind": "grep", "cwd": td, "path": ".", "maxDepth": 65})["error"]["code"] == -32602
        assert send(p, 5, "job.start", {"sessionId": "s", "jobId": "bad4", "kind": "grep", "cwd": td, "path": ".", "pattern": "beta", "maxNodes": 0})["error"]["code"] == -32602
        assert send(p, 6, "job.start", {"sessionId": "s", "jobId": "bad5", "kind": "grep", "cwd": td, "path": ".", "pattern": "beta", "maxMs": 300001})["error"]["code"] == -32602
        assert send(p, 7, "job.start", {"sessionId": "s", "jobId": "bad6", "kind": "grep", "cwd": td, "path": "denied", "pattern": "beta"})["error"]["code"] == -32002
        assert send(p, 8, "job.start", {"sessionId": "s", "jobId": "bad7", "kind": "grep", "cwd": td, "path": ".", "pattern": ""})["error"]["code"] == -32602

        # Full grep: all matches sorted by path then line, deny rules honoured.
        status = run_search(p, "grep-full", "grep", "beta")
        assert status["state"] == "completed", status
        matches, summary = search_output(p, "grep-full")
        # Verify sorted by path, then line
        keys = [(m["path"], m["line"]) for m in matches]
        assert keys == sorted(keys), keys
        assert summary["truncated"] is False, summary
        # denied/secret.txt must not appear
        assert not any(m["path"].startswith("denied") for m in matches), matches
        # Check specific matches
        src_matches = [m for m in matches if m["path"] == "src/main.ts"]
        assert len(src_matches) == 1, src_matches
        assert src_matches[0]["line"] == 2, src_matches
        assert "beta" in src_matches[0]["text"], src_matches
        # Verify many/ files were searched (parallel grep)
        many_matches = [m for m in matches if m["path"].startswith("many/")]
        assert len(many_matches) == 50, len(many_matches)

        # Result determinism: a second grep produces identical results.
        status = run_search(p, "grep-again", "grep", "beta")
        assert status["state"] == "completed", status
        again, again_summary = search_output(p, "grep-again")
        assert again == matches, "two greps of an unchanged tree must agree"
        assert again_summary == summary

        # include filter: only search .ts files
        status = run_search(p, "grep-ts", "grep", "beta", include=["*.ts"])
        assert status["state"] == "completed", status
        ts_matches, ts_summary = search_output(p, "grep-ts")
        assert all(m["path"].endswith(".ts") for m in ts_matches), ts_matches
        assert not any(m["path"].endswith(".md") for m in ts_matches), ts_matches

        # exclude filter: skip src/ files
        status = run_search(p, "grep-excl", "grep", "beta", exclude=["src/*"])
        assert status["state"] == "completed", status
        excl_matches, _ = search_output(p, "grep-excl")
        assert not any(m["path"].startswith("src/") for m in excl_matches), excl_matches

        # Node budget truncates the walk.
        status = run_search(p, "grep-nodes", "grep", "beta", maxNodes=5)
        assert status["state"] == "completed", status
        _, nodes_summary = search_output(p, "grep-nodes")
        assert nodes_summary["truncated"] is True and nodes_summary["reason"] == "nodes", nodes_summary

        # Depth budget truncates recursion.
        status = run_search(p, "grep-depth", "grep", "beta", maxDepth=1)
        assert status["state"] == "completed", status
        depth_matches, depth_summary = search_output(p, "grep-depth")
        assert depth_summary["truncated"] is True and depth_summary["reason"] == "depth", depth_summary
        assert not any("deep/one/two" in m["path"] for m in depth_matches), depth_matches

        # Time budget stops the walk on a larger tree.
        slow = root / "slow"
        slow.mkdir()
        for d in range(100):
            sub = slow / f"d{d:03}"
            sub.mkdir()
            for i in range(100):
                (sub / f"f{i:03}.txt").write_text("beta")
        status = run_search(p, "grep-time", "grep", "beta", maxMs=1)
        assert status["state"] == "completed", status
        _, time_summary = search_output(p, "grep-time")
        assert time_summary["truncated"] is True and time_summary["reason"] == "time", time_summary

        # Page size 1 forces multi-page output draining.
        status = run_search(p, "grep-page", "grep", "beta", include=["src/*"])
        assert status["state"] == "completed", status
        page_matches, _ = search_output(p, "grep-page", page_limit=1)
        assert page_matches == [m for m in matches if m["path"].startswith("src/")], page_matches

        # Cancellation: searching many files cannot finish before cancel lands.
        started = send(p, "start", "job.start", {"sessionId": "s", "jobId": "grep-cancel", "kind": "grep", "cwd": td, "path": ".", "pattern": "beta"})
        assert started["result"]["state"] == "running", started
        cancelled = send(p, "cancel", "job.cancel", {"sessionId": "s", "jobId": "grep-cancel"})["result"]
        assert cancelled == {"jobId": "grep-cancel", "accepted": True}, cancelled
        assert wait_terminal(p, "grep-cancel")["state"] == "cancelled"

        # --- glob job ---

        # Invalid inputs
        assert send(p, 20, "job.start", {"sessionId": "s", "jobId": "gbad1", "kind": "glob", "cwd": td, "path": ".", "pattern": "*.ts", "unexpected": True})["error"]["code"] == -32602
        assert send(p, 21, "job.start", {"sessionId": "s", "jobId": "gbad2", "kind": "glob", "cwd": td, "path": ".", "pattern": ""})["error"]["code"] == -32602

        # Full glob: all matching paths sorted, deny rules honoured.
        status = run_search(p, "glob-ts", "glob", "*.ts")
        assert status["state"] == "completed", status
        glob_entries, glob_summary = search_output(p, "glob-ts")
        glob_paths = [e["path"] for e in glob_entries]
        assert glob_paths == sorted(glob_paths), glob_paths
        assert glob_summary["truncated"] is False, glob_summary
        assert "src/main.ts" in glob_paths and "src/util.ts" in glob_paths, glob_paths
        assert not any(p.startswith("denied") for p in glob_paths), glob_paths
        # All 50 many/ files plus src/ files
        assert len([p for p in glob_paths if p.startswith("many/")]) == 50, glob_paths

        # Glob determinism
        status = run_search(p, "glob-again", "glob", "*.ts")
        assert status["state"] == "completed", status
        glob_again, _ = search_output(p, "glob-again")
        assert glob_again == glob_entries, "two globs of an unchanged tree must agree"

        # Glob with deeper pattern
        status = run_search(p, "glob-deep", "glob", "deep/**/*.txt")
        assert status["state"] == "completed", status
        deep_entries, _ = search_output(p, "glob-deep")
        deep_paths = [e["path"] for e in deep_entries]
        assert "deep/one/two/leaf.txt" in deep_paths, deep_paths

        # Glob with include/exclude
        status = run_search(p, "glob-excl", "glob", "*", exclude=["many/*"])
        assert status["state"] == "completed", status
        excl_entries, _ = search_output(p, "glob-excl")
        excl_paths = [e["path"] for e in excl_entries]
        assert not any(p.startswith("many/") for p in excl_paths), excl_paths

        # Glob node budget
        status = run_search(p, "glob-nodes", "glob", "*", maxNodes=5)
        assert status["state"] == "completed", status
        _, gnodes_summary = search_output(p, "glob-nodes")
        assert gnodes_summary["truncated"] is True and gnodes_summary["reason"] == "nodes", gnodes_summary

        # Glob cancellation
        started = send(p, "start", "job.start", {"sessionId": "s", "jobId": "glob-cancel", "kind": "glob", "cwd": td, "path": ".", "pattern": "*"})
        assert started["result"]["state"] == "running", started
        cancelled = send(p, "cancel", "job.cancel", {"sessionId": "s", "jobId": "glob-cancel"})["result"]
        assert cancelled == {"jobId": "glob-cancel", "accepted": True}, cancelled
        assert wait_terminal(p, "glob-cancel")["state"] == "cancelled"

        # Single-directory enumeration cap: 300 files exceed the 256-entry
        # listing budget, flagged as truncated with reason "list".
        wide = root / "wide"
        wide.mkdir()
        for i in range(300):
            (wide / f"w-{i:04}.txt").write_text("beta")
        status = run_search(p, "grep-list", "grep", "beta", path="wide")
        assert status["state"] == "completed", status
        _, glist_summary = search_output(p, "grep-list")
        assert glist_summary["truncated"] is True and glist_summary["reason"] == "list", glist_summary
        status = run_search(p, "glob-list", "glob", "*", path="wide")
        assert status["state"] == "completed", status
        _, plist_summary = search_output(p, "glob-list")
        assert plist_summary["truncated"] is True and plist_summary["reason"] == "list", plist_summary

        # --- no-follow: links are never traversed ---

        link = root / "escape"
        if directory_link(link, pathlib.Path(outside)):
            (pathlib.Path(outside) / "outside.txt").write_text("beta outside")
            # grep must not find matches through the link
            status = run_search(p, "grep-nofollow", "grep", "beta")
            assert status["state"] == "completed", status
            nf_matches, _ = search_output(p, "grep-nofollow")
            assert not any("escape" in m["path"] for m in nf_matches), nf_matches
            assert not any(m["path"] == "outside.txt" for m in nf_matches), nf_matches
            # glob must not list paths through the link
            status = run_search(p, "glob-nofollow", "glob", "*")
            assert status["state"] == "completed", status
            nf_paths = [e["path"] for e in search_output(p, "glob-nofollow")[0]]
            assert not any("escape" in p for p in nf_paths), nf_paths
            assert not any(p == "outside.txt" for p in nf_paths), nf_paths

        assert send(p, 99, "core.shutdown", {})["result"]["ok"] is True
    assert p.wait(timeout=5) == 0
    atexit.unregister(cleanup_process)


if __name__ == "__main__":
    main()
