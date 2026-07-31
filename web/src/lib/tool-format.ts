import type { DiffSpec } from "../components/editor/DiffPane";

const TOOL_SUMMARY_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "cwd"];

/** 从工具入参中提取最具辨识度的一项（命令/路径等）作为摘要 */
export function summarizeToolInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** 从 write_file/edit_file 工具入参构造 diff 视图打开规格；非文件改动工具返回 undefined */
export function diffSpecForTool(name: string, input?: Record<string, unknown>): DiffSpec | undefined {
  const path = typeof input?.path === "string" ? input.path : undefined;
  if (!path) return undefined;
  if (name === "write_file") return { source: "agent-write", path, content: String(input?.content ?? "") };
  if (name === "edit_file") return { source: "agent-edit", path, oldText: String(input?.oldText ?? ""), newText: String(input?.newText ?? "") };
  return undefined;
}

/** 尝试将工具结果 JSON 解析为可读格式；解析失败返回 undefined 回退原始文本。 */
export function formatToolContent(content: string): { summary: string; body: string } | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    // bash 工具结果：提取 exitCode/stdout/stderr
    if (typeof parsed.exitCode === "number" && Array.isArray(parsed.output)) {
      const stdout = (parsed.output as Array<{ stream: string; data: string }>).filter((c) => c.stream === "stdout").map((c) => c.data).join("");
      const stderr = (parsed.output as Array<{ stream: string; data: string }>).filter((c) => c.stream === "stderr").map((c) => c.data).join("");
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      return {
        summary: `exit ${parsed.exitCode}${parsed.durationMs ? ` · ${parsed.durationMs}ms` : ""}`,
        body: parts.join("\n") || "(no output)",
      };
    }
    // read_file 结果：直接展示内容
    if (typeof parsed.content === "string" && typeof parsed.totalLines === "number") {
      return { summary: `${parsed.totalLines} lines`, body: parsed.content };
    }
    // glob 结果：展示路径列表
    if (Array.isArray(parsed.paths)) {
      const paths = parsed.paths as string[];
      return { summary: `${paths.length} files`, body: paths.join("\n") || "(no matches)" };
    }
    // write_file / edit_file：简单成功
    if (parsed.ok === true) return { summary: "ok", body: "" };
    if (typeof parsed.matches === "number") return { summary: `${parsed.matches} matches`, body: "" };
    // grep 结果：展示匹配行
    if (Array.isArray(parsed.matches)) {
      const matches = parsed.matches as Array<{ path: string; line: number; text: string }>;
      const body = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
      return { summary: `${matches.length} matches`, body: body || "(no matches)" };
    }
    // 其他 JSON：pretty-print
    return { summary: "", body: JSON.stringify(parsed, null, 2) };
  } catch {
    return undefined;
  }
}
