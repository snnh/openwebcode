import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MEMORY_SECTION_LIMIT = 8_000;

/**
 * 长期记忆/项目约定注入段构建（自 agent-runner.ts 抽出的纯代码移动，行为不变）：
 * host fs 直读 CLAUDE.md、AGENTS.md、项目 .owc/memory.md 与全局 <dataDir>/memory.md；
 * 每节独立标题、上限 8000 字符，读失败一律按不存在处理，绝不 throw 阻断 agent 循环。
 */
export class MemorySectionBuilder {
  /** 记忆文件指纹缓存（绝对路径 → mtimeMs+size+内容）：每轮注入不重读未变文件；多会话按路径共享。 */
  private readonly memoryFileCache = new Map<string, { mtimeMs: number; size: number; content: string }>();

  constructor(private readonly dataDir?: string) {}

  async build(cwd: string): Promise<string> {
    const sections: string[] = [];
    const add = (title: string, body: string): void => {
      const trimmed = body.trim();
      if (trimmed === "") return;
      const text = trimmed.length > MEMORY_SECTION_LIMIT ? `${trimmed.slice(0, MEMORY_SECTION_LIMIT)}…(truncated)` : trimmed;
      sections.push(`## ${title}\n${text}`);
    };
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      add(name, await this.readMemoryFileCached(path.join(cwd, name)));
    }
    add("Project memory (.owc/memory.md)", await this.readMemoryFileCached(path.join(cwd, ".owc", "memory.md")));
    if (this.dataDir) add("Global memory", await this.readMemoryFileCached(path.join(this.dataDir, "memory.md")));
    return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
  }

  /**
   * 带 mtimeMs+size 指纹缓存的记忆文件读取：文件未变（指纹一致）直接返回缓存内容，
   * 避免每轮 4 次无缓存磁盘读；不存在/不可读一律按空串处理（同注入路径语义）。
   */
  private async readMemoryFileCached(filePath: string): Promise<string> {
    let stats: { mtimeMs: number; size: number };
    try {
      stats = await stat(filePath);
    } catch {
      this.memoryFileCache.delete(filePath);
      return "";
    }
    const cached = this.memoryFileCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.content;
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      // stat 成功但读失败（权限/竞态删除）：按不存在处理，不写缓存
      this.memoryFileCache.delete(filePath);
      return "";
    }
    this.memoryFileCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, content });
    return content;
  }
}
