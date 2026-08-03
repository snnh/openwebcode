import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../../atomic-file.js";

/**
 * 可编辑的系统提示词覆盖（plan 提示词修改功能），七个配置面：
 * - 身份行 identity：<dir>/system-prompt-identity.md（覆盖首行 "You are OpenWebCode..."；
 *   env-sim persona 身份优先于此覆盖）
 * - 基线覆盖 base：<dir>/system-prompt.md（完整覆盖内置 PI_BASE_SYSTEM_PROMPT）
 * - 追加指令 append：<dir>/system-prompt-append.md（finalConstraints 之后插入）
 * - 子代理附加 subAgentAppend：<dir>/system-prompt-subagent.md（拼入所有子代理系统提示，
 *   追加在自定义子代理 body 之后）
 * - /init 命令 init：<dir>/command-init-prompt.md（覆盖 /init 展开的内置探查提示词；
 *   env-sim persona 的 initPrompt 次之、内置最后）
 * - compact 概览 compactOverview：<dir>/compact-prompt-overview.md（覆盖 overview 压缩系统提示词）
 * - compact 工具占位 compactToolcalls：<dir>/compact-prompt-toolcalls.md（覆盖 toolcalls 压缩系统提示词）
 *
 * 每一面都有全局（<dataDir>/）与项目（<cwd>/.owc/）两级同名文件。
 * 合并语义与 hooks/mcp/memory 的两级模式一致：逐面独立合并，项目级存在时整面覆盖全局
 * （不是拼接）。字段缺省（文件不存在或为空）即无该面覆盖，旧格式（仅 base/append 文件）
 * 自然兼容。
 *
 * 提示词不是安全边界——plan-mode/权限/沙箱由 Node/Core 独立强制，不受此处覆盖影响。
 */
export interface PromptOverride {
  /** 覆盖首行身份行；undefined 表示沿用默认。 */
  identityOverride?: string;
  /** 覆盖内置 Pi 基线的文本；undefined 表示沿用内置。 */
  baseOverride?: string;
  /** 追加到 finalConstraints 之后的自定义指令；undefined 表示无追加。 */
  customAppend?: string;
  /** 拼入所有子代理系统提示的附加指令；undefined 表示无附加。 */
  subAgentAppend?: string;
  /** 覆盖 /init 命令展开的内置探查提示词；undefined 表示沿用内置。 */
  initOverride?: string;
  /** 覆盖 overview 压缩系统提示词；undefined 表示沿用内置。 */
  compactOverviewOverride?: string;
  /** 覆盖 toolcalls 压缩系统提示词；undefined 表示沿用内置。 */
  compactToolcallsOverride?: string;
}

/** 七个配置面与落盘文件名的对应表（一文件一面，全局/项目两级同名）。 */
const OVERRIDE_FACES = [
  { key: "identityOverride", file: "system-prompt-identity.md" },
  { key: "baseOverride", file: "system-prompt.md" },
  { key: "customAppend", file: "system-prompt-append.md" },
  { key: "subAgentAppend", file: "system-prompt-subagent.md" },
  { key: "initOverride", file: "command-init-prompt.md" },
  { key: "compactOverviewOverride", file: "compact-prompt-overview.md" },
  { key: "compactToolcallsOverride", file: "compact-prompt-toolcalls.md" },
] as const;

type OverrideFaceKey = (typeof OVERRIDE_FACES)[number]["key"];

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

/** 只读单个目录下的四面覆盖文件（不做两级合并），供按作用域读取。 */
export async function loadScopedPromptOverride(dir: string): Promise<PromptOverride> {
  const override: Partial<Record<OverrideFaceKey, string>> = {};
  for (const face of OVERRIDE_FACES) {
    const value = await readFileIfExists(path.join(dir, face.file));
    if (value) override[face.key] = value;
  }
  return override;
}

/**
 * 按内置 -> 全局 -> 项目顺序解析当前生效的提示词覆盖。
 * 逐面独立合并：项目级某面存在时覆盖全局同面；均不存在时返回空对象（沿用内置）。
 */
export async function loadPromptOverride(dataDir: string, cwd: string): Promise<PromptOverride> {
  const global = await loadScopedPromptOverride(dataDir);
  const project = cwd ? await loadScopedPromptOverride(path.join(cwd, ".owc")) : {};
  const merged: Partial<Record<OverrideFaceKey, string>> = {};
  for (const face of OVERRIDE_FACES) {
    const value = project[face.key] ?? global[face.key];
    if (value) merged[face.key] = value;
  }
  return merged;
}

export type PromptOverrideWriteBody = Partial<Record<OverrideFaceKey, string>>;

/** 把四面覆盖写入指定目录：非空写入（trim + 末尾换行），空/缺省删除对应文件。 */
async function writePromptOverrideTo(dir: string, body: PromptOverrideWriteBody): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const face of OVERRIDE_FACES) {
    const target = path.join(dir, face.file);
    const value = body[face.key];
    if (value && value.trim() !== "") {
      await writeUtf8Atomically(target, `${value.trim()}\n`);
    } else {
      await safeUnlink(target);
    }
  }
}

/** 写入全局级（<dataDir>/）覆盖文件。 */
export async function writeGlobalPromptOverride(dataDir: string, body: PromptOverrideWriteBody): Promise<void> {
  await writePromptOverrideTo(dataDir, body);
}

/** 写入项目级（<cwd>/.owc/）覆盖文件；cwd 合法性由调用方（REST 层会话校验）保证。 */
export async function writeProjectPromptOverride(cwd: string, body: PromptOverrideWriteBody): Promise<void> {
  await writePromptOverrideTo(path.join(cwd, ".owc"), body);
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
