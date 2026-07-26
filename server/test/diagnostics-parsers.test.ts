import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fallbackDiagnosticSet, parseTestOutput } from "../src/diagnostics/parsers.js";

const FIXTURES = path.join(__dirname, "fixtures", "diagnostics");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");

describe("测试输出解析器 golden（0.4.0 Phase 3a）", () => {
  it("vitest --reporter=json：JSON 输出解析为 DiagnosticSet", async () => {
    const output = await fixture("vitest-json.txt");
    const parsed = parseTestOutput("npx vitest run --reporter=json", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("vitest");
    expect(parsed!.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({
      name: "math > divides numbers",
      file: "D:/proj/src/math.test.ts",
      line: 11,
    });
    expect(parsed!.failures[0].message).toContain("expected 2 to be 3");
  });

  it("vitest 文本输出：FAIL 块 + 摘要行", async () => {
    const output = await fixture("vitest-text.txt");
    const parsed = parseTestOutput("npx vitest run", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("vitest");
    expect(parsed!.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1, durationMs: 312 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "math > divides numbers", file: "src/math.test.ts" });
    expect(parsed!.failures[0].message).toContain("AssertionError: expected 2 to be 3");
  });

  it("pytest 文本输出：FAILED 行 + short summary", async () => {
    const output = await fixture("pytest-text.txt");
    const parsed = parseTestOutput("pytest", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("pytest");
    expect(parsed!.summary).toMatchObject({ passed: 3, failed: 1, skipped: 0, durationMs: 420 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "tests/test_math.py::test_divides", file: "tests/test_math.py" });
    expect(parsed!.failures[0].message).toContain("AssertionError");

    const parsedCrlf = parseTestOutput("pytest", output.replace(/\n/g, "\r\n"));
    expect(parsedCrlf).toEqual(parsed);
  });

  it("go test -json：事件流解析", async () => {
    const output = await fixture("go-json.txt");
    const parsed = parseTestOutput("go test -json ./...", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("go");
    expect(parsed!.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1, durationMs: 50 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "TestDivide", file: "example.com/proj/math" });
    expect(parsed!.failures[0].message).toContain("got 3, want 4");
  });

  it("go test 文本输出：--- FAIL 块 + 包行时长", async () => {
    const output = await fixture("go-text.txt");
    const parsed = parseTestOutput("go test ./...", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("go");
    expect(parsed!.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1, durationMs: 50 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "TestDivide" });
    expect(parsed!.failures[0].message).toContain("got 3, want 4");
  });

  it("dotnet test trx：XML 内联输出解析", async () => {
    const output = await fixture("dotnet-trx.txt");
    const parsed = parseTestOutput("dotnet test --logger trx", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("dotnet");
    expect(parsed!.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
    expect(parsed!.summary.durationMs).toBe(4);
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "Proj.Tests.MathTests.Divides" });
    expect(parsed!.failures[0].message).toContain("Assert.AreEqual failed");
    expect(parsed!.failures[0].excerpt).toContain("MathTests.cs:line 13");
  });

  it("dotnet test 文本输出：Failed! 摘要 + Failed 块", async () => {
    const output = await fixture("dotnet-text.txt");
    const parsed = parseTestOutput("dotnet test", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("dotnet");
    expect(parsed!.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1, durationMs: 12 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "Proj.Tests.MathTests.Divides" });
    expect(parsed!.failures[0].message).toContain("Assert.AreEqual failed");
  });

  it("解析失败回退：乱输出返回 undefined，fallback 保留工具识别与空 failures", () => {
    const garbage = "@@not-a-test-output@@\n\x00\x01 random bytes !!!\n";
    expect(parseTestOutput("make weird", garbage)).toBeUndefined();
    const fallback = fallbackDiagnosticSet("make weird", garbage);
    expect(fallback.tool).toBe("unknown");
    expect(fallback.summary).toEqual({ passed: 0, failed: 0, skipped: 0, durationMs: 0 });
    expect(fallback.failures).toEqual([]);
    // 已知命令但输出无法解析：回退保留工具名
    const pytestFallback = fallbackDiagnosticSet("pytest --weird", garbage);
    expect(pytestFallback.tool).toBe("pytest");
  });
});
