import { describe, expect, it } from "vitest";
import { filterAndRank, fuzzyScore } from "../lib/fuzzy";

describe("fuzzyScore 模糊匹配", () => {
  it("非子序列不匹配返回 -1", () => {
    expect(fuzzyScore("xyz", "src/app.ts")).toBe(-1);
    expect(fuzzyScore("app", "app.ts")).toBeGreaterThanOrEqual(0);
  });

  it("连续命中与词首命中得分更高", () => {
    expect(fuzzyScore("app", "app.ts")).toBeGreaterThan(fuzzyScore("app", "a-p-p.ts"));
    expect(fuzzyScore("cp", "CommandPalette.tsx")).toBeGreaterThan(fuzzyScore("cp", "score-panel.ts"));
  });

  it("空查询匹配一切", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("filterAndRank", () => {
  const files = ["src/components/QuickOpen.tsx", "src/commands/registry.ts", "README.md", "src/lib/fuzzy.ts"];

  it("过滤并按相关性排序", () => {
    const result = filterAndRank("reg", files, (path) => path);
    expect(result[0]).toBe("src/commands/registry.ts");
    expect(result).not.toContain("README.md");
  });

  it("空查询保留原顺序", () => {
    expect(filterAndRank("", files, (path) => path)).toEqual(files);
  });

  it("Quick Open 场景：文件名模糊匹配", () => {
    const result = filterAndRank("qko", files, (path) => path);
    expect(result).toEqual(["src/components/QuickOpen.tsx"]);
  });
});
