import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "./model-profile.js";

export const TOOL_RESULT_BUDGETS: Record<string, number> = {
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
  const maxChars = budget * 4;
  const visible = content.slice(0, maxChars);
  return {
    content: `${visible}\n[truncated: original approximately ${originalTokens} tokens; full output artifact:${artifactId}]`,
    artifactId,
    truncated: true,
    originalTokens,
  };
}
