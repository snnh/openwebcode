import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens, maxPrefixWithinTokenBudget } from "./model-profile.js";

const TOOL_RESULT_BUDGETS: Record<string, number> = {
  bash: 8_000,
  read_file: 16_000,
  grep: 4_000,
  glob: 4_000,
  web_fetch: 8_000,
  web_search: 4_000,
  repo_map: 16_000,
};

interface BoundedToolResult {
  content: string;
  artifactId?: string;
  truncated: boolean;
  originalTokens: number;
}

export async function boundToolResult(
  sessionRoot: string,
  toolName: string,
  content: string,
): Promise<BoundedToolResult> {
  const budget = TOOL_RESULT_BUDGETS[toolName] ?? 8_000;
  const originalTokens = estimateTokens(content);
  if (originalTokens <= budget) return { content, truncated: false, originalTokens };

  const artifactId = `artifact-${randomUUID()}`;
  await mkdir(path.join(sessionRoot, "artifacts"), { recursive: true });
  await writeFile(path.join(sessionRoot, "artifacts", `${artifactId}.txt`), content, "utf8");
  // 截断口径必须与 estimateTokens 一致（该函数对 CJK 按约 1.5 字符/token 折算）：
  // 旧的 `budget * 4` 字符是按 ASCII 4 字符/token 的假设，中文结果截断后仍约 2.7 倍超预算。
  // 尾部截断提示自身也占预算：先算它的 token 成本，再从预算里扣掉再取前缀，
  // 保证 estimateTokens(返回内容) ≤ budget。
  const notice = truncationNotice(originalTokens, artifactId);
  const visibleChars = maxPrefixWithinTokenBudget(content, budget - estimateTokens(notice));
  const visible = content.slice(0, visibleChars);
  return {
    content: `${visible}${notice}`,
    artifactId,
    truncated: true,
    originalTokens,
  };
}

/** 截断提示（artifact 可续读线索）：文本格式被 agent 侧截断说明与续读工具依赖，勿改。 */
function truncationNotice(originalTokens: number, artifactId: string): string {
  return `\n[truncated: original approximately ${originalTokens} tokens; full output artifact:${artifactId}]`;
}
