#!/usr/bin/env python3
"""index.extract job contract tests.

Covers the symbol-extraction job kind: per-language golden extraction
aligned with the server-side TypeScript extractor golden tests
(server/test/index-symbols.test.ts is the behavior oracle), unsupported
extension / oversize / non-UTF-8 skipping, per-file symbol caps, byte and
time budgets, cancellation, and session path policy.  Runs on Windows and
Linux.
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


def wait_terminal(p, job_id, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = send(p, "status", "job.status", {"sessionId": "s", "jobId": job_id})["result"]
        if status["state"] != "running":
            return status
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not reach a terminal state")


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


CWD = None


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


if __name__ == "__main__":
    main()
