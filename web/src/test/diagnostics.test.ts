import { describe, expect, it } from "vitest";
import type { DiagnosticFailure, DiagnosticSet } from "../lib/contracts";
import {
  applyDiagnosticsBadgeUpdate,
  clearDiagnosticsBadge,
  countBySeverity,
  filterGroupsBySeverity,
  groupFailuresByFile,
  severityOf,
} from "../lib/diagnostics";

const failure = (partial: Partial<DiagnosticFailure>): DiagnosticFailure => ({
  name: "test",
  message: "failed",
  ...partial,
});

describe("severityOf", () => {
  it("severityOf：失败含 error 语义归 error、仅 warning 归 warning", () => {
    expect(severityOf(failure({ name: "login 用例", message: "expected 200, got 500" }))).toBe("error");
    expect(severityOf(failure({ message: "warning: deprecated but also error later" }))).toBe("error");
    expect(severityOf(failure({ message: "warning: unused variable" }))).toBe("warning");
  });
});

describe("groupFailuresByFile", () => {
  it("按文件分组并保持顺序，未定位到文件的组排在最后", () => {
    const groups = groupFailuresByFile([
      failure({ name: "b1", file: "b.ts" }),
      failure({ name: "no-file" }),
      failure({ name: "a1", file: "a.ts" }),
      failure({ name: "b2", file: "b.ts" }),
    ]);
    expect(groups.map((group) => group.file)).toEqual(["a.ts", "b.ts", ""]);
    expect(groups[1]!.items.map((item) => item.name)).toEqual(["b1", "b2"]);
  });
});

describe("filterGroupsBySeverity", () => {
  const set: DiagnosticSet = {
    tool: "vitest",
    summary: { passed: 1, failed: 2, skipped: 0, durationMs: 120 },
    failures: [
      failure({ name: "boom", file: "a.ts", message: "failed hard" }),
      failure({ name: "lint", file: "a.ts", message: "warning: style" }),
      failure({ name: "other", file: "b.ts", message: "warning: style" }),
    ],
  };
  const groups = groupFailuresByFile(set.failures);

  it("filterGroupsBySeverity：all/error/warning 过滤（空组移除）与 countBySeverity 统计", () => {
    expect(filterGroupsBySeverity(groups, "all")).toHaveLength(2);

    // error 过滤后仅剩含 error 的组
    const filtered = filterGroupsBySeverity(groups, "error");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.items.map((item) => item.name)).toEqual(["boom"]);

    // warning 过滤后移除空组
    const warningFiltered = filterGroupsBySeverity(groups, "warning");
    expect(warningFiltered.map((group) => group.file)).toEqual(["a.ts", "b.ts"]);
    expect(warningFiltered[0]!.items.map((item) => item.name)).toEqual(["lint"]);

    // countBySeverity 统计两档数量
    expect(countBySeverity(set)).toEqual({ error: 1, warning: 2 });
    expect(countBySeverity(undefined)).toEqual({ error: 0, warning: 0 });
  });
});

describe("diagnostics.updated 角标逻辑", () => {
  it("diagnostics.updated：角标取最新失败数，0 清除该会话", () => {
    // 到达时把该会话角标设为最新失败数（绝对值，不累加）
    let badges: Record<string, number> = {};
    badges = applyDiagnosticsBadgeUpdate(badges, "s1", 3);
    badges = applyDiagnosticsBadgeUpdate(badges, "s1", 5);
    badges = applyDiagnosticsBadgeUpdate(badges, "s2", 1);
    expect(badges).toEqual({ s1: 5, s2: 1 });

    // failed 为 0 时清除该会话角标，不影响其他会话
    const cleared = applyDiagnosticsBadgeUpdate({ s1: 4, s2: 2 }, "s1", 0);
    expect(cleared).toEqual({ s2: 2 });
  });

  it("clearDiagnosticsBadge 清除指定会话；无变化时返回原引用", () => {
    const previous = { s1: 2 };
    expect(clearDiagnosticsBadge(previous, "s1")).toEqual({});
    expect(clearDiagnosticsBadge(previous, "missing")).toBe(previous);
    expect(applyDiagnosticsBadgeUpdate(previous, "s1", 2)).toBe(previous);
  });
});
