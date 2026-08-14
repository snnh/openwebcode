import type { DiagnosticFailure, DiagnosticSet } from "./contracts";

export type DiagnosticSeverity = "error" | "warning";
export type SeverityFilter = "all" | DiagnosticSeverity;

/** 契约未携带严重度字段：测试失败一律归 error；明确含 warning 语义且不含失败语义的归 warning */
export function severityOf(failure: DiagnosticFailure): DiagnosticSeverity {
  const text = `${failure.name}\n${failure.message}`;
  if (/\bwarn(ing)?\b/i.test(text) && !/\b(fail(?:ed|ure)?|error)\b/i.test(text)) return "warning";
  return "error";
}

interface DiagnosticFileGroup {
  /** 相对路径；空串表示无法定位到文件的失败项 */
  file: string;
  items: DiagnosticFailure[];
}

/** 按文件分组（保持原有顺序），无法定位到文件的组排在最后 */
export function groupFailuresByFile(failures: DiagnosticFailure[]): DiagnosticFileGroup[] {
  const byFile = new Map<string, DiagnosticFailure[]>();
  for (const failure of failures) {
    const key = failure.file ?? "";
    const group = byFile.get(key);
    if (group) group.push(failure);
    else byFile.set(key, [failure]);
  }
  return [...byFile.entries()]
    .map(([file, items]) => ({ file, items }))
    .sort((a, b) => {
      if (a.file === "") return b.file === "" ? 0 : 1;
      if (b.file === "") return -1;
      return a.file.localeCompare(b.file);
    });
}

/** 按严重度过滤分组；过滤后空组被移除 */
export function filterGroupsBySeverity(groups: DiagnosticFileGroup[], filter: SeverityFilter): DiagnosticFileGroup[] {
  if (filter === "all") return groups;
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => severityOf(item) === filter) }))
    .filter((group) => group.items.length > 0);
}

export function countBySeverity(set: DiagnosticSet | undefined): Record<DiagnosticSeverity, number> {
  const counts: Record<DiagnosticSeverity, number> = { error: 0, warning: 0 };
  for (const failure of set?.failures ?? []) counts[severityOf(failure)] += 1;
  return counts;
}

/**
 * Problems 面板角标：diagnostics.updated 到达时把该会话角标设为最新失败数（绝对值，不累加）；
 * failed 为 0 时清除角标。只读、不弹窗，用户打开 Problems 标签页后由 clearDiagnosticsBadge 清除。
 */
export function applyDiagnosticsBadgeUpdate(
  previous: Record<string, number>,
  sessionId: string,
  failed: number,
): Record<string, number> {
  if (failed <= 0) return clearDiagnosticsBadge(previous, sessionId);
  if (previous[sessionId] === failed) return previous;
  return { ...previous, [sessionId]: failed };
}

export function clearDiagnosticsBadge(previous: Record<string, number>, sessionId: string): Record<string, number> {
  if (!(sessionId in previous)) return previous;
  const { [sessionId]: _cleared, ...remaining } = previous;
  return remaining;
}
