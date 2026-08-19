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


def wait_terminal(p, job_id, timeout=30, session_id="s"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = send(p, "status", "job.status", {"sessionId": session_id, "jobId": job_id})["result"]
        if status["state"] != "running":
            return status
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not reach a terminal state")


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


CWD = None


def main_index_scan():
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


# --- index.extract job contract (absorbed from test_index_extract.py) ---
#
# Covers the symbol-extraction job kind: per-language golden extraction
# aligned with the server-side TypeScript extractor golden tests
# (server/test/index-symbols.test.ts is the behavior oracle), unsupported
# extension / oversize / non-UTF-8 skipping, per-file symbol caps, byte and
# time budgets, cancellation, and session path policy.  Runs on Windows and
# Linux.


def extract_output(p, job_id, page_limit=64):
    """Drain the JSONL result through the bounded job.output pagination."""
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


def run_extract(p, job_id, files, **params):
    request = {"sessionId": "s", "jobId": job_id, "kind": "index.extract", "cwd": CWD, "path": "src", "files": files}
    request.update(params)
    response = send(p, "start", "job.start", request)
    assert "result" in response, response
    assert response["result"]["state"] == "running", response
    return wait_terminal(p, job_id)


def simplify(entry):
    return [f"{s['kind']}:{s['name']}@{s['startLine']}" for s in entry["symbols"]]


# Fixture corpora mirror server/test/index-symbols.test.ts; the expected
# kind:name@line lists below are the TypeScript extractor's golden output.
TYPESCRIPT = "\n".join([
    "export function greet(name: string): string {",
    "  return name;",
    "}",
    "export class Greeter {",
    '  private prefix = "hi";',
    "  async sayHello(name: string) {",
    "    return greet(name);",
    "  }",
    "}",
    "export interface Config { debug: boolean }",
    'export type Mode = "a" | "b";',
    "export enum Level { Low, High }",
    'export const DEFAULT_MODE: Mode = "a";',
])
TYPESCRIPT_EXPECT = ["function:greet@1", "class:Greeter@4", "method:sayHello@6", "interface:Config@10",
                     "type:Mode@11", "enum:Level@12", "constant:DEFAULT_MODE@13"]

JAVASCRIPT = 'function helper() {\n}\nexport const VERSION = "1.0.0";\nclass App {\n  static create() {\n  }\n}'
JAVASCRIPT_EXPECT = ["function:helper@1", "constant:VERSION@3", "class:App@4", "method:create@5"]

PYTHON = "def top_level(a, b):\n    return a\n\nclass Service:\n    def handle(self, request):\n        return request\n\nasync def fetch(url):\n    pass"
PYTHON_EXPECT = ["function:top_level@1", "class:Service@4", "method:handle@5", "function:fetch@8"]

GO = "package main\n\nfunc main() {\n}\n\nfunc (s *Server) Start(addr string) error {\n  return nil\n}\n\ntype Config struct {\n  Port int\n}\n\ntype Handler interface {\n  Serve()\n}\n\ntype Port = int"
GO_EXPECT = ["function:main@3", "method:Start@6", "struct:Config@10", "interface:Handler@14", "type:Port@18"]

RUST = "pub fn compute(x: i32) -> i32 {\n  x * 2\n}\n\npub struct Point {\n  x: f64,\n}\n\nenum Color {\n  Red,\n}\n\npub trait Drawable {\n  fn draw(&self);\n}\n\nimpl Point {\n  fn new() -> Self { Point { x: 0.0 } }\n}\n\nconst MAX_RETRY: u32 = 3;"
RUST_EXPECT = ["function:compute@1", "struct:Point@5", "enum:Color@9", "trait:Drawable@13",
               "function:draw@14", "impl:Point@17", "function:new@18", "constant:MAX_RETRY@21"]

RUST2 = "fn f() {}\nstruct S {}\ntrait T {}\nimpl S {}\nimpl Drawable for Point {\n}\nconst C: u8 = 0;"
RUST2_EXPECT = ["function:f@1", "struct:S@2", "trait:T@3", "impl:S@4", "impl:Point@5", "constant:C@7"]

C_SOURCE = "#include <stdio.h>\n\nint add(int a, int b) {\n  return a + b;\n}\n\nint subtract(int a, int b);\n\nstruct node {\n  int value;\n};\n\nstatic void helper(void)\n{\n}"
C_EXPECT = ["function:add@3", "struct:node@9", "function:helper@13"]

CPP_SOURCE = "class Widget {\npublic:\n  void draw();\n};\n\nvoid render(Widget& w) {\n  w.draw();\n}"
CPP_EXPECT = ["class:Widget@1", "function:render@6"]

JAVA = "public class App {\n  private final String name;\n\n  public App(String name) {\n    this.name = name;\n  }\n\n  public static void main(String[] args) {\n  }\n\n  public String name() {\n    return name;\n  }\n}\n\ninterface Repository {\n  void save();\n}"
JAVA_EXPECT = ["class:App@1", "method:App@4", "method:main@8", "method:name@11", "interface:Repository@16"]

CSHARP = "public class Program {\n  private readonly int count;\n\n  public static void Main(string[] args) {\n  }\n\n  private async Task RunAsync() {\n    await Task.Yield();\n  }\n}\n\npublic struct Vec2 {\n  public float X;\n}\n\ninternal interface IService {\n  void Start();\n}"
CSHARP_EXPECT = ["class:Program@1", "method:Main@4", "method:RunAsync@7", "struct:Vec2@12", "interface:IService@16"]

RANGES = "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}"
RANGES_EXPECT = [
    {"name": "a", "kind": "function", "startLine": 1, "endLine": 3, "signature": "function a() {"},
    {"name": "b", "kind": "function", "startLine": 4, "endLine": 6, "signature": "function b() {"},
]

FIXTURES = {
    "sample.ts": (TYPESCRIPT, TYPESCRIPT_EXPECT),
    "sample.js": (JAVASCRIPT, JAVASCRIPT_EXPECT),
    "sample.py": (PYTHON, PYTHON_EXPECT),
    "sample.go": (GO, GO_EXPECT),
    "sample.rs": (RUST, RUST_EXPECT),
    "sample2.rs": (RUST2, RUST2_EXPECT),
    "sample.c": (C_SOURCE, C_EXPECT),
    "sample.cpp": (CPP_SOURCE, CPP_EXPECT),
    "Sample.java": (JAVA, JAVA_EXPECT),
    "Sample.cs": (CSHARP, CSHARP_EXPECT),
}


def main_index_extract():
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

    with tempfile.TemporaryDirectory() as td:
        CWD = td
        root = pathlib.Path(td)
        src = root / "src"
        src.mkdir()
        for name, (content, _) in FIXTURES.items():
            (src / name).write_text(content, encoding="utf-8", newline="\n")
        (src / "ranges.ts").write_text(RANGES, encoding="utf-8", newline="\n")
        (src / "notes.md").write_text("function notCode() {\n}\n", encoding="utf-8", newline="\n")
        (src / "Makefile").write_text("function notCode() {\n}\n", encoding="utf-8", newline="\n")
        (src / "binary.ts").write_bytes(b"function broken() {\n}\n\xff\xfe\x00invalid")
        (src / "big.ts").write_bytes(b"export function big() {\n}\n//" + b"x" * (1024 * 1024))
        (src / "many.ts").write_text("".join(f"export function fn{i}() {{\n}}\n" for i in range(10)), encoding="utf-8", newline="\n")
        (src / "huge.ts").write_text("".join(f"export function fn{i}() {{\n}}\n" for i in range(250)), encoding="utf-8", newline="\n")
        for i in range(4):
            (src / f"budget{i}.ts").write_text(f"export function budget{i}() {{\n  return {i};\n}}\n", encoding="utf-8", newline="\n")
        (root / "denied").mkdir()
        (root / "denied" / "secret.ts").write_text("function secret() {\n}\n", encoding="utf-8", newline="\n")
        gen = root / "gen"
        gen.mkdir()
        gen_files = []
        for i in range(400):
            name = f"f{i:04}.ts"
            (gen / name).write_text(f"export function gen{i}() {{\n  return {i};\n}}\n", encoding="utf-8", newline="\n")
            gen_files.append(name)
        slow = root / "slow"
        slow.mkdir()
        slow_files = []
        padding = "  // padding line for cancellation timing\n" * 800
        for i in range(2000):
            name = f"s{i:04}.ts"
            (slow / name).write_text(f"export function slow{i}() {{\n{padding}}}\n", encoding="utf-8", newline="\n")
            slow_files.append(name)

        configured = send(p, 1, "session.configure", {"sessionId": "s", "cwd": td, "sandbox": {"enabled": True, "readRoots": [td], "writeRoots": [td], "denyPaths": [str(root / "denied")], "network": "allow"}})
        assert configured["result"]["sandboxCapability"] in {"advisory", "partial", "enforced"}, configured

        # Unknown fields and invalid parameters are rejected before a job starts.
        base = {"sessionId": "s", "jobId": "bad", "kind": "index.extract", "cwd": td, "path": "src", "files": ["sample.ts"]}
        assert send(p, 2, "job.start", {**base, "jobId": "bad1", "unexpected": True})["error"]["code"] == -32602
        missing_files = {k: v for k, v in base.items() if k != "files"}
        assert send(p, 3, "job.start", {**missing_files, "jobId": "bad2"})["error"]["code"] == -32602
        assert send(p, 4, "job.start", {**base, "jobId": "bad3", "files": "sample.ts"})["error"]["code"] == -32602
        assert send(p, 5, "job.start", {**base, "jobId": "bad4", "files": [""]})["error"]["code"] == -32602
        assert send(p, 6, "job.start", {**base, "jobId": "bad5", "files": ["x" * 1025 + ".ts"]})["error"]["code"] == -32602
        assert send(p, 7, "job.start", {**base, "jobId": "bad6", "maxSymbolsPerFile": 0})["error"]["code"] == -32602
        assert send(p, 8, "job.start", {**base, "jobId": "bad7", "maxSymbolsPerFile": 10001})["error"]["code"] == -32602
        assert send(p, 9, "job.start", {**base, "jobId": "bad8", "maxBytes": 0})["error"]["code"] == -32602
        assert send(p, 10, "job.start", {**base, "jobId": "bad9", "maxBytes": 1073741825})["error"]["code"] == -32602
        assert send(p, 11, "job.start", {**base, "jobId": "bad10", "maxMs": 300001})["error"]["code"] == -32602
        assert send(p, 12, "job.start", {**base, "jobId": "bad11", "path": "denied"})["error"]["code"] == -32002

        # Golden per-language extraction, aligned with the TypeScript oracle.
        ordered = list(FIXTURES.keys())
        status = run_extract(p, "golden", ordered + ["ranges.ts", "notes.md", "Makefile", "binary.ts", "missing.ts"])
        assert status["state"] == "completed", status
        entries, summary = extract_output(p, "golden")
        by_path = {e["path"]: e for e in entries}
        assert set(by_path) == set(ordered) | {"ranges.ts"}, by_path.keys()
        for name in ordered:
            assert simplify(by_path[name]) == FIXTURES[name][1], (name, simplify(by_path[name]))
        # endLine ranges and bounded signatures follow the TypeScript semantics.
        assert by_path["ranges.ts"]["symbols"] == RANGES_EXPECT, by_path["ranges.ts"]
        expected_symbols = sum(len(expect) for _, expect in FIXTURES.values()) + len(RANGES_EXPECT)
        assert summary == {"files": len(ordered) + 1, "symbols": expected_symbols, "truncated": False, "reason": None}, summary

        # An empty file list yields only the summary line.
        status = run_extract(p, "empty", [])
        assert status["state"] == "completed", status
        empty_entries, empty_summary = extract_output(p, "empty")
        assert empty_entries == [] and empty_summary == {"files": 0, "symbols": 0, "truncated": False, "reason": None}, (empty_entries, empty_summary)

        # Policy: deny-listed descendants and traversal spellings are skipped.
        denied = send(p, "start", "job.start", {"sessionId": "s", "jobId": "policy", "kind": "index.extract", "cwd": td, "path": ".", "files": ["denied/secret.ts", "../outside.ts", "src/sample.ts"]})
        assert denied["result"]["state"] == "running", denied
        assert wait_terminal(p, "policy")["state"] == "completed"
        policy_entries, policy_summary = extract_output(p, "policy")
        assert [e["path"] for e in policy_entries] == ["src/sample.ts"], policy_entries
        assert policy_summary["files"] == 1 and policy_summary["symbols"] == len(TYPESCRIPT_EXPECT), policy_summary

        # Files larger than 1 MiB are skipped without failing the job.
        status = run_extract(p, "oversize", ["big.ts", "sample.ts"])
        assert status["state"] == "completed", status
        oversize_entries, oversize_summary = extract_output(p, "oversize")
        assert [e["path"] for e in oversize_entries] == ["sample.ts"], oversize_entries
        assert oversize_summary == {"files": 1, "symbols": len(TYPESCRIPT_EXPECT), "truncated": False, "reason": None}, oversize_summary

        # maxSymbolsPerFile overrides the per-file cap.
        status = run_extract(p, "capped", ["many.ts"], maxSymbolsPerFile=3)
        assert status["state"] == "completed", status
        capped_entries, capped_summary = extract_output(p, "capped")
        assert simplify(capped_entries[0]) == ["function:fn0@1", "function:fn1@3", "function:fn2@5"], capped_entries
        assert capped_summary["symbols"] == 3 and capped_summary["truncated"] is False, capped_summary

        # The default cap is 200 symbols per file.
        status = run_extract(p, "default-cap", ["huge.ts"])
        assert status["state"] == "completed", status
        huge_entries, huge_summary = extract_output(p, "default-cap")
        assert len(huge_entries[0]["symbols"]) == 200, len(huge_entries[0]["symbols"])
        assert huge_entries[0]["symbols"][-1]["name"] == "fn199", huge_entries[0]["symbols"][-1]
        assert huge_summary["symbols"] == 200, huge_summary

        # maxBytes is a total read budget: the file that would cross it stops
        # the job with truncated=true, reason "bytes".
        byte_sizes = [len((src / f"budget{i}.ts").read_bytes()) for i in range(4)]
        status = run_extract(p, "bytes", [f"budget{i}.ts" for i in range(4)], maxBytes=byte_sizes[0] + byte_sizes[1] + 1)
        assert status["state"] == "completed", status
        bytes_entries, bytes_summary = extract_output(p, "bytes")
        assert [e["path"] for e in bytes_entries] == ["budget0.ts", "budget1.ts"], bytes_entries
        assert bytes_summary == {"files": 2, "symbols": 2, "truncated": True, "reason": "bytes"}, bytes_summary

        # Time budget stops the job promptly on a larger file set.
        status = run_extract(p, "time", gen_files, path="gen", maxMs=1)
        assert status["state"] == "completed", status
        _, time_summary = extract_output(p, "time")
        assert time_summary["truncated"] is True and time_summary["reason"] == "time", time_summary

        # Cancellation: two thousand padded files cannot finish before the
        # cancel lands, so the terminal state must be cancelled.
        started = send(p, "start", "job.start", {"sessionId": "s", "jobId": "cancel-me", "kind": "index.extract", "cwd": td, "path": "slow", "files": slow_files})
        assert started["result"]["state"] == "running", started
        cancelled = send(p, "cancel", "job.cancel", {"sessionId": "s", "jobId": "cancel-me"})["result"]
        assert cancelled == {"jobId": "cancel-me", "accepted": True}, cancelled
        assert wait_terminal(p, "cancel-me")["state"] == "cancelled"

        assert send(p, 99, "core.shutdown", {})["result"]["ok"] is True
    assert p.wait(timeout=5) == 0
    atexit.unregister(cleanup_process)


# --- grep / glob job contract (absorbed from test_search_job.py) ---
#
# Covers the 0.5.0 Phase 2c search primitives: job.start kind=grep and
# kind=glob.  Verifies deterministic sorted output, content search
# correctness, include/exclude filtering, node/depth/time budgets,
# cancellation, no-follow behaviour, parallel grep (multiple workers find
# all matches), and bounded job.output pagination.  Runs on Windows and
# Linux; platform-specific no-follow coverage skips gracefully when link
# creation is not permitted.


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


def main_search_job():
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


def main():
    main_index_scan()
    main_index_extract()
    main_search_job()


if __name__ == "__main__":
    main()
