import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMissing } from "./fs-utils.js";

/**
 * 长期记忆（plan §2.3/§7.5）：
 * - 项目级：<cwd>/.owc/memory.md；全局级：<dataDir>/memory.md（跨会话共享）
 * - 内容为 "- " 子弹列表；系统提示每轮注入，remember 工具与压缩沉淀两处写入
 */

/** 读文本；任何失败按不存在处理（注入路径绝不阻断 agent 循环）。 */
async function readOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export function readProjectMemory(cwd: string): Promise<string> {
  return readOrEmpty(path.join(cwd, ".owc", "memory.md"));
}

export function readGlobalMemory(dataDir: string): Promise<string> {
  return readOrEmpty(path.join(dataDir, "memory.md"));
}

/**
 * 把 facts 逐条作为 "- " 子弹追加到 filePath：
 * - 与文件中已有子弹（trim 后文本相同）重复的事实跳过
 * - 自动 mkdir recursive；新文件先写头（.owc 下为项目记忆，否则按全局记忆）
 */
export async function appendMemory(filePath: string, facts: string[]): Promise<{ appended: number }> {
  const wanted = [...new Set(facts.map((fact) => fact.trim()).filter((fact) => fact !== ""))];
  let existing = "";
  try {
    existing = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const present = new Set(
    existing
      .split("\n")
      .map((line) => line.match(/^\s*[-*]\s+(.+)$/))
      .filter((item) => item !== null)
      .map((item) => item[1]!.trim()),
  );
  const fresh = wanted.filter((fact) => !present.has(fact));
  if (fresh.length === 0) return { appended: 0 };
  await mkdir(path.dirname(filePath), { recursive: true });
  const bullets = `${fresh.map((fact) => `- ${fact}`).join("\n")}\n`;
  if (existing === "") {
    const header = path.basename(path.dirname(filePath)) === ".owc" ? "# Memory\n" : "# Global Memory\n";
    await writeFile(filePath, header + bullets, "utf8");
  } else {
    await appendFile(filePath, (existing.endsWith("\n") ? "" : "\n") + bullets, "utf8");
  }
  return { appended: fresh.length };
}

const SEDIMENT_SECTIONS = ["关键发现", "未决事项"];
const OTHER_SECTIONS = ["目标", "行动", "修改文件", "用户明确指令"];

/**
 * 从 overview 摘要中解析「关键发现」「未决事项」两个小节的 "- " 列表项。
 * 小节标题兼容 **粗体** 标记与中/英文冒号；其他小节及非列表行终止当前小节。
 */
export function parseSedimentSections(summary: string): string[] {
  const collected: string[] = [];
  const seen = new Set<string>();
  let inSection = false;
  for (const line of summary.split("\n")) {
    if (SEDIMENT_SECTIONS.some((title) => line.includes(title))) {
      inSection = true;
      continue;
    }
    if (OTHER_SECTIONS.some((title) => line.includes(title))) {
      inSection = false;
      continue;
    }
    if (!inSection || line.trim() === "") continue;
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (!item) {
      inSection = false;
      continue;
    }
    const text = item[1]!.trim();
    if (text !== "" && !seen.has(text)) {
      seen.add(text);
      collected.push(text);
    }
  }
  return collected;
}
