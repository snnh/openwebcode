import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../../atomic-file.js";

/**
 * 可编辑的系统提示词覆盖（plan 提示词修改功能）：
 * - 全局基线覆盖：<dataDir>/system-prompt.md（完整覆盖内置 PI_BASE_SYSTEM_PROMPT）
 * - 项目级基线覆盖：<cwd>/.owc/system-prompt.md（存在时覆盖全局）
 * - 全局追加指令：<dataDir>/system-prompt-append.md（finalConstraints 之后插入）
 * - 项目级追加指令：<cwd>/.owc/system-prompt-append.md（存在时覆盖全局）
 *
 * 与 hooks/mcp/memory 的两级模式一致：项目同名覆盖全局。
 * 提示词不是安全边界——plan-mode/权限/沙箱由 Node/Core 独立强制，不受此处覆盖影响。
 */
export interface PromptOverride {
  /** 覆盖内置 Pi 基线的文本；undefined 表示沿用内置。 */
  baseOverride?: string;
  /** 追加到 finalConstraints 之后的自定义指令；undefined 表示无追加。 */
  customAppend?: string;
}

/** 文件不存在的错误按 undefined 处理；其他读取错误同样不阻断 agent 循环。 */
async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return content.trim() === "" ? undefined : content.trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    // 损坏文件不阻断 agent：记 stderr 后按未覆盖处理
    process.stderr.write(`[prompt] 读取 ${filePath} 失败：${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

/**
 * 按内置 -> 全局 -> 项目顺序解析当前生效的提示词覆盖。
 * 项目级存在时覆盖全局级；均不存在时返回空对象（沿用内置）。
 */
export async function loadPromptOverride(dataDir: string, cwd: string): Promise<PromptOverride> {
  const globalBase = await readFileIfExists(path.join(dataDir, "system-prompt.md"));
  const projectBase = await readFileIfExists(path.join(cwd, ".owc", "system-prompt.md"));
  const baseOverride = projectBase ?? globalBase;

  const globalAppend = await readFileIfExists(path.join(dataDir, "system-prompt-append.md"));
  const projectAppend = await readFileIfExists(path.join(cwd, ".owc", "system-prompt-append.md"));
  const customAppend = projectAppend ?? globalAppend;

  return {
    ...(baseOverride ? { baseOverride } : {}),
    ...(customAppend ? { customAppend } : {}),
  };
}

/** 写入全局级覆盖文件（项目级 .owc 文件由用户手工管理）。 */
export async function writeGlobalPromptOverride(
  dataDir: string,
  body: { baseOverride?: string; customAppend?: string },
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const baseTarget = path.join(dataDir, "system-prompt.md");
  const appendTarget = path.join(dataDir, "system-prompt-append.md");
  if (body.baseOverride && body.baseOverride.trim() !== "") {
    await writeUtf8Atomically(baseTarget, `${body.baseOverride.trim()}\n`);
  } else {
    await safeUnlink(baseTarget);
  }
  if (body.customAppend && body.customAppend.trim() !== "") {
    await writeUtf8Atomically(appendTarget, `${body.customAppend.trim()}\n`);
  } else {
    await safeUnlink(appendTarget);
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
