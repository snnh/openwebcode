import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimateTokens, maxPrefixWithinTokenBudget } from "../src/context/model-profile.js";
import { boundToolResult } from "../src/context/tool-result-budget.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("工具结果预算与截断口径", () => {
  it("maxPrefixWithinTokenBudget 与 estimateTokens 同口径，且不切开代理对", () => {
    // ASCII 4 字符/token、CJK 1.5 字符/token；😀 整对计一次 token
    expect(maxPrefixWithinTokenBudget("abcdefgh", 1)).toBe(4);
    expect(maxPrefixWithinTokenBudget("中文中文", 2)).toBe(3);
    expect(maxPrefixWithinTokenBudget("ab😀cd", 1)).toBe(2);

    const mixed = "x".repeat(50) + "中文😀".repeat(30) + "y".repeat(50);
    for (const budget of [1, 2, 5, 13, 40, 100]) {
      expect(estimateTokens(mixed.slice(0, maxPrefixWithinTokenBudget(mixed, budget)))).toBeLessThanOrEqual(budget);
    }
  });

  it("纯中文结果截断后不超预算（旧实现按 4 字符/token 会超约 2.7 倍），全文仍可从 artifact 续读", async () => {
    const root = await tempRoot("owc-tool-budget-cjk-");
    const content = "中文内容重复".repeat(4_000); // 约 16000 tokens，grep 预算 4000
    const bounded = await boundToolResult(root, "grep", content);

    expect(bounded.truncated).toBe(true);
    expect(bounded.originalTokens).toBe(estimateTokens(content));
    expect(estimateTokens(bounded.content)).toBeLessThanOrEqual(4_000);
    const visible = bounded.content.split("\n[truncated:")[0] ?? "";
    // 中文按 1.5 字符/token 可留更多字符；截断只在前缀上切
    expect(visible.length).toBeGreaterThan(4_000);
    expect(content.startsWith(visible)).toBe(true);
    expect(await readFile(path.join(root, "artifacts", `${bounded.artifactId}.txt`), "utf8")).toBe(content);

    // 未超预算：原样返回、不落 artifact
    expect(await boundToolResult(root, "grep", "短结果")).toEqual({
      content: "短结果",
      truncated: false,
      originalTokens: estimateTokens("短结果"),
    });
  });

  it("混合内容（ASCII + 中文 + emoji）：用满预算且不产出孤立代理码元", async () => {
    const root = await tempRoot("owc-tool-budget-mixed-");
    const content = ("console.log(\"hi\")\n" + "中文日志😀".repeat(20)).repeat(1_000);
    const bounded = await boundToolResult(root, "grep", content);

    expect(bounded.truncated).toBe(true);
    expect(estimateTokens(bounded.content)).toBeLessThanOrEqual(4_000);
    expect(estimateTokens(bounded.content)).toBeGreaterThan(3_600);
    // 孤立代理码元经 UTF-8 往返会变成 U+FFFD
    expect(Buffer.from(bounded.content, "utf8").toString("utf8")).toBe(bounded.content);
  });
});
