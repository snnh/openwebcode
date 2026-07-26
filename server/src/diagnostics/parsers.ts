import type { DiagnosticFailure, DiagnosticSet, DiagnosticTool } from "./types.js";

/**
 * 表驱动测试输出解析器注册表（0.4.0 Phase 3a）。
 * 每个解析器声明 match(command, output) 与 parse(output)；parse 返回 undefined
 * 表示识别失败，由注册表尝试下一个，全部失败则走 fallback（保留原文尾部）。
 * 新增生态只需向 PARSERS 追加一项。
 */
export interface TestOutputParser {
  tool: DiagnosticTool;
  match(command: string, output: string): boolean;
  parse(output: string): DiagnosticSet | undefined;
}

/** 解析失败回退时保留的原文尾部上限（字符）。 */
export const FALLBACK_TAIL_CHARS = 8_000;

function toInt(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 从输出中定位第一个完整 JSON 对象（--json / --reporter=json 模式输出可能混有日志行）。 */
function extractJson(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// ---- vitest / jest ----

interface JestJsonAssertion {
  fullName?: string;
  title?: string;
  status?: string;
  location?: { line?: number; column?: number };
  failureMessages?: string[];
}

function parseJestJson(output: string, tool: "vitest" | "jest"): DiagnosticSet | undefined {
  const json = extractJson(output) as {
    numTotalTests?: number; numPassedTests?: number; numFailedTests?: number; numPendingTests?: number;
    testResults?: Array<{ name?: string; assertionResults?: JestJsonAssertion[] }>;
  } | undefined;
  if (!json || typeof json.numTotalTests !== "number" || !Array.isArray(json.testResults)) return undefined;
  const failures: DiagnosticFailure[] = [];
  for (const suite of json.testResults) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status !== "failed") continue;
      const message = (assertion.failureMessages ?? []).join("\n").trim();
      failures.push({
        name: assertion.fullName ?? assertion.title ?? "(unnamed test)",
        ...(suite.name ? { file: suite.name } : {}),
        ...(assertion.location?.line !== undefined ? { line: assertion.location.line } : {}),
        message: message || "Test failed",
        ...(message ? { excerpt: message } : {}),
      });
    }
  }
  return {
    tool,
    summary: {
      passed: toInt(String(json.numPassedTests)),
      failed: toInt(String(json.numFailedTests)),
      skipped: toInt(String(json.numPendingTests)),
      durationMs: 0,
    },
    failures,
  };
}

function parseJestText(output: string, tool: "vitest" | "jest"): DiagnosticSet | undefined {
  // jest 文本摘要："Tests: 1 failed, 2 passed, 3 total"；vitest：" Tests  1 failed | 2 passed (3)"
  const jestSummary = output.match(/^\s*Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(?:(\d+) passed,\s*)?(\d+) total\s*$/m);
  const vitestSummary = output.match(/^\s*Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|\s*(\d+) skipped)?\s*\((\d+)\)\s*$/m);
  const durationMatch = output.match(/(?:Time|Duration):?\s+([\d.]+)\s*(ms|s)\b/);
  let summary: DiagnosticSet["summary"] | undefined;
  if (jestSummary) {
    summary = { failed: toInt(jestSummary[1]), skipped: toInt(jestSummary[2]), passed: toInt(jestSummary[3]), durationMs: 0 };
  } else if (vitestSummary) {
    summary = { failed: toInt(vitestSummary[1]), skipped: toInt(vitestSummary[3]), passed: toInt(vitestSummary[2]), durationMs: 0 };
  }
  if (!summary) return undefined;
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    summary.durationMs = durationMatch[2] === "s" ? Math.round(value * 1000) : Math.round(value);
  }
  const failures: DiagnosticFailure[] = [];
  // jest "● Suite › test" 块作为失败详情；vitest 同样输出 " FAIL  src/x.test.ts > suite > test" 与 "× test" 行。
  const failBlocks = output.split(/\n(?=\s*● )/);
  for (const block of failBlocks.slice(1)) {
    const header = block.match(/^\s*●\s+(.+?)\s*$/m);
    if (!header) continue;
    const name = header[1] ?? "";
    if (/^Console|^Test suite failed/.test(name)) continue;
    const message = block.split("\n").slice(1).join("\n").trim();
    failures.push({ name, message: message || "Test failed", ...(message ? { excerpt: message } : {}) });
  }
  if (failures.length === 0) {
    const lines = output.split("\n");
    // × 行仅在没有任何 FAIL 块时兜底（避免与 FAIL 块重复计数）
    const hasFailBlocks = lines.some((line) => /^\s*FAIL\s+\S/.test(line));
    for (const [index, line] of lines.entries()) {
      const vitestFail = line.match(/^\s*FAIL\s+(\S+?)(?:\s+>\s+(.+))?\s*$/);
      if (vitestFail) {
        // 收集 FAIL 行之后的错误详情（缩进行/非空行），直到空行或下一标记
        const detail: string[] = [];
        for (const follow of lines.slice(index + 1)) {
          if (/^\s*$/.test(follow) && detail.length > 0) break;
          if (/^\s*(FAIL|✓|×|✗|Test Files|Tests|Duration)\b/.test(follow)) break;
          if (!/^\s*$/.test(follow)) detail.push(follow.trim());
        }
        const message = detail.join("\n") || "Test failed";
        failures.push({ name: vitestFail[2]?.trim() ?? vitestFail[1] ?? "(unnamed test)", ...(vitestFail[1] ? { file: vitestFail[1] } : {}), message, ...(detail.length > 0 ? { excerpt: message } : {}) });
        continue;
      }
      const jestCross = line.match(/^\s*[×✕✗]\s+(.+?)\s*(?:\(\d+ ms\))?\s*$/);
      if (jestCross && jestCross[1] && !hasFailBlocks) failures.push({ name: jestCross[1], message: "Test failed" });
    }
  }
  if (summary.failed > 0 && failures.length === 0) return undefined;
  summary.failed = Math.max(summary.failed, failures.length);
  return { tool, summary, failures };
}

function makeJestLikeParser(tool: "vitest" | "jest", commandNeedle: RegExp): TestOutputParser {
  return {
    tool,
    // jest --json 输出带 numTotalTests 特征，即使命令为 npm test 也能识别
    match: (command, output) => commandNeedle.test(command) || /"numTotalTests"\s*:/.test(output),
    parse: (output) => parseJestJson(output, tool) ?? parseJestText(output, tool),
  };
}

// ---- pytest ----

const PYTEST_PARSER: TestOutputParser = {
  tool: "pytest",
  match: (command) => /\bpytest\b/.test(command),
  parse: (output) => {
    // 短摘要行："=== 2 failed, 3 passed, 1 skipped in 0.42s ==="（顺序/项可变）
    const summaryLine = output.match(/^=+\s+(.+?)\s+in\s+([\d.]+)s\s*=+\s*$/m);
    if (!summaryLine) return undefined;
    const parts = summaryLine[1] ?? "";
    const count = (kind: string): number => {
      const match = parts.match(new RegExp(`(\\d+) ${kind}`));
      return match?.[1] ? toInt(match[1]) : 0;
    };
    const summary = {
      failed: count("failed"),
      passed: count("passed"),
      skipped: count("skipped") + count("deselected"),
      durationMs: Math.round(Number(summaryLine[2]) * 1000),
    };
    if (summary.failed + summary.passed + summary.skipped === 0 && !/\d+ (error|warning)/.test(parts)) return undefined;
    const failures: DiagnosticFailure[] = [];
    // 短摘要中的 "FAILED tests/test_x.py::test_y - AssertionError: ..." 行
    for (const line of output.split("\n")) {
      const failed = line.match(/^FAILED\s+(\S+?)(?:\s+-\s+(.*))?$/);
      if (!failed) continue;
      const nodeid = failed[1] ?? "";
      const location = nodeid.match(/^(.*\.py)::(.*?)(?:::(.*))?$/);
      const message = failed[2]?.trim() || "Test failed";
      failures.push({
        name: nodeid,
        ...(location?.[1] ? { file: location[1] } : {}),
        message,
        excerpt: message,
      });
    }
    // "== ERRORS ==" 段的收集错误也计入失败名（无 FAILED 行时兜底）
    if (summary.failed > 0 && failures.length === 0) {
      for (const line of output.split("\n")) {
        const errHead = line.match(/^_{2,}\s+(?:ERROR at (?:setup|teardown|collection) of\s+)?(.+?)\s+_{2,}\s*$/);
        if (errHead?.[1]) failures.push({ name: errHead[1], message: "Test failed" });
      }
      if (failures.length === 0) return undefined;
    }
    return { tool: "pytest", summary, failures };
  },
};

// ---- go test ----

const GO_PARSER: TestOutputParser = {
  tool: "go",
  match: (command) => /\bgo\s+test\b/.test(command),
  parse: (output) => parseGoJson(output) ?? parseGoText(output),
};

function parseGoJson(output: string): DiagnosticSet | undefined {
  const lines = output.split("\n").filter((line) => line.trim().startsWith("{"));
  if (lines.length === 0) return undefined;
  interface GoEvent { Action?: string; Package?: string; Test?: string; Elapsed?: number; Output?: string }
  const events: GoEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as GoEvent);
    } catch {
      return undefined;
    }
  }
  if (!events.some((event) => event.Action === "pass" || event.Action === "fail")) return undefined;
  const perTest = new Map<string, { action: string; elapsed: number; output: string[]; pkg?: string }>();
  let passed = 0, failed = 0, skipped = 0, durationMs = 0;
  for (const event of events) {
    if (!event.Test) {
      if ((event.Action === "pass" || event.Action === "fail") && event.Elapsed !== undefined) durationMs += Math.round(event.Elapsed * 1000);
      continue;
    }
    const entry = perTest.get(event.Test) ?? { action: "", elapsed: 0, output: [], ...(event.Package ? { pkg: event.Package } : {}) };
    if (event.Action === "output" && event.Output) entry.output.push(event.Output.replace(/\n$/, ""));
    if (event.Action === "pass" || event.Action === "fail" || event.Action === "skip") {
      entry.action = event.Action;
      entry.elapsed = event.Elapsed ?? 0;
    }
    perTest.set(event.Test, entry);
  }
  const failures: DiagnosticFailure[] = [];
  for (const [test, entry] of perTest) {
    if (entry.action === "pass") passed++;
    else if (entry.action === "skip") skipped++;
    else if (entry.action === "fail") {
      failed++;
      const excerpt = entry.output.join("\n").trim();
      failures.push({ name: test, ...(entry.pkg ? { file: entry.pkg } : {}), message: excerpt || "Test failed", ...(excerpt ? { excerpt } : {}) });
    }
  }
  return { tool: "go", summary: { passed, failed, skipped, durationMs }, failures };
}

function parseGoText(output: string): DiagnosticSet | undefined {
  const lines = output.split("\n");
  if (!lines.some((line) => /^(ok|FAIL|---\s+(?:FAIL|PASS|SKIP))/.test(line))) return undefined;
  let passed = 0, failed = 0, skipped = 0, durationMs = 0;
  const failures: DiagnosticFailure[] = [];
  let current: DiagnosticFailure | undefined;
  const flush = () => {
    if (!current) return;
    if (current.excerpt) current.excerpt = current.excerpt.trim();
    if (current.excerpt) current.message = current.excerpt;
    failures.push(current);
    current = undefined;
  };
  for (const line of lines) {
    const marker = line.match(/^---\s+(FAIL|PASS|SKIP):\s+(\S+)\s+\(([\d.]+)s\)/);
    if (marker) {
      flush();
      if (marker[1] === "PASS") passed++;
      else if (marker[1] === "SKIP") skipped++;
      else {
        failed++;
        current = { name: marker[2] ?? "(unnamed test)", message: "Test failed", excerpt: "" };
      }
      continue;
    }
    if (current) {
      current.excerpt = `${current.excerpt ?? ""}${line}\n`;
      continue;
    }
    const pkgLine = line.match(/^(ok|FAIL)\s+(\S+)\s+([\d.]+)s/);
    if (pkgLine) durationMs += Math.round(Number(pkgLine[3]) * 1000);
  }
  flush();
  if (passed + failed + skipped === 0) return undefined;
  return { tool: "go", summary: { passed, failed, skipped, durationMs }, failures };
}

// ---- dotnet test ----

const DOTNET_PARSER: TestOutputParser = {
  tool: "dotnet",
  match: (command, output) => /\bdotnet\s+test\b/.test(command) || /<TestRun[\s>]/.test(output),
  parse: (output) => parseTrx(output) ?? parseDotnetText(output),
};

function parseTrx(output: string): DiagnosticSet | undefined {
  const trx = output.includes("<TestRun") ? output.slice(output.indexOf("<TestRun")) : undefined;
  if (!trx) return undefined;
  const results = [...trx.matchAll(/<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)];
  if (results.length === 0) return undefined;
  let passed = 0, failed = 0, skipped = 0, durationMs = 0;
  const failures: DiagnosticFailure[] = [];
  const attr = (attrs: string, name: string): string | undefined => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  for (const result of results) {
    const attrs = result[1] ?? "";
    const outcome = attr(attrs, "outcome") ?? "";
    const duration = attr(attrs, "duration") ?? "0:0:0";
    const parts = duration.split(":").map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) durationMs += Math.round((((parts[0] ?? 0) * 60 + (parts[1] ?? 0)) * 60 + (parts[2] ?? 0)) * 1000);
    if (outcome === "Passed") passed++;
    else if (outcome === "Failed") {
      failed++;
      const message = result[3]?.match(/<Message>([\s\S]*?)<\/Message>/)?.[1]?.trim() || "Test failed";
      const stack = result[3]?.match(/<StackTrace>([\s\S]*?)<\/StackTrace>/)?.[1]?.trim();
      failures.push({ name: attr(attrs, "testName") ?? "(unnamed test)", message, excerpt: stack ? `${message}\n${stack}` : message });
    } else skipped++;
  }
  return { tool: "dotnet", summary: { passed, failed, skipped, durationMs }, failures };
}

function parseDotnetText(output: string): DiagnosticSet | undefined {
  // "Failed!  - Failed: 1, Passed: 2, Skipped: 0, Total: 3, Duration: 12 ms"
  const summaryLine = output.match(/(?:Passed!|Failed!)\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)(?:,\s*Duration:\s*([\d.]+)\s*(ms|s))?/);
  if (!summaryLine) return undefined;
  const summary = {
    failed: toInt(summaryLine[1]),
    passed: toInt(summaryLine[2]),
    skipped: toInt(summaryLine[3]),
    durationMs: summaryLine[5] ? Math.round(Number(summaryLine[5]) * (summaryLine[6] === "s" ? 1000 : 1)) : 0,
  };
  const failures: DiagnosticFailure[] = [];
  // "  Failed TestName [3 ms]\n  Error Message:\n   ..."
  const blocks = output.split(/\n(?=\s*Failed\s+\S)/);
  for (const block of blocks.slice(1)) {
    const header = block.match(/^\s*Failed\s+(\S+)\s*(?:\[[\d.]+ ?(?:ms|s)\])?\s*$/m);
    if (!header) continue;
    const messageMatch = block.match(/Error Message:\s*\n([\s\S]*?)(?:\n\s*Stack Trace:|$)/);
    const message = messageMatch?.[1]?.trim() || "Test failed";
    failures.push({ name: header[1] ?? "(unnamed test)", message, excerpt: message });
  }
  if (summary.failed > 0 && failures.length === 0) return undefined;
  return { tool: "dotnet", summary, failures };
}

/** 注册表顺序即优先级；新增生态解析器追加到末尾。 */
export const PARSERS: readonly TestOutputParser[] = [
  makeJestLikeParser("vitest", /\bvitest\b/),
  makeJestLikeParser("jest", /\bjest\b/),
  PYTEST_PARSER,
  GO_PARSER,
  DOTNET_PARSER,
];

/** 按命令与输出选择解析器并解析；全部失败返回 undefined（调用方走回退）。 */
export function parseTestOutput(command: string, output: string): DiagnosticSet | undefined {
  const normalizedOutput = output.replace(/\r\n?/g, "\n");
  for (const parser of PARSERS) {
    if (!parser.match(command, normalizedOutput)) continue;
    const parsed = parser.parse(normalizedOutput);
    if (parsed) return parsed;
  }
  return undefined;
}

/** 解析失败回退：summary 置零、无 failures，原文尾部由调用方存入 artifact。 */
export function fallbackDiagnosticSet(command: string, output: string): DiagnosticSet {
  const normalizedOutput = output.replace(/\r\n?/g, "\n");
  const matched = PARSERS.find((parser) => parser.match(command, normalizedOutput));
  return { tool: matched?.tool ?? "unknown", summary: { passed: 0, failed: 0, skipped: 0, durationMs: 0 }, failures: [] };
}
