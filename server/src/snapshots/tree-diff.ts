/**
 * 非 git-shadow 快照后端的树级差异：有界遍历双侧目录（size/mtime 对比），
 * 变更文件逐个走 `git diff --no-index`（文件 diff 统一走 git），输出与
 * git-shadow 相同形态的 stat 摘要 + unified diff（parseUnifiedDiff 可直接解析）。
 *
 * 边界与降级：
 * - walk 有节点预算；单文件内容超限、变更文件超限均只出 stat 行并如实标注截断；
 * - 单侧缺失（新增/删除）文件手工合成 /dev/null 头 + 全文件 hunk（跨平台，不依赖 NUL）；
 * - 二进制文件（内容含 NUL）只出 stat 行；
 * - 系统无 git（spawn ENOENT）时返回 null，调用方降级为现有摘要实现（不谎报）。
 */
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { truncateLines } from "./backend.js";

export interface DiffTreesOptions {
  /** 双侧 walk 的相对路径前缀排除（组件边界匹配；工作区侧 excludes 目录防「已删除」误报） */
  excludePrefixes?: string[];
  /** 相对路径 glob 排除（contextExcludes 语义：`**` 跨目录、`*` 单段、`?` 单字符） */
  excludeGlobs?: string[];
  /** 单文件内容对比上限（字节），超限该文件只出 stat 行 */
  maxFileBytes?: number;
  /** 变更文件内容 diff 上限，超限的剩余文件只出 stat 行 */
  changedCap?: number;
  /** walk 节点预算（双侧合计），超预算截断并如实标注 */
  maxNodes?: number;
  /** overlayfs upper 层语义：字符设备 = whiteout 删除标记，遍历时跳过（等价不存在） */
  whiteoutAsDeleted?: boolean;
}

/** 快照 diff 的会话 excludes：相对化 denyPaths（工作区外条目跳过）+ contextExcludes。 */
export interface SnapshotDiffExcludes {
  excludePrefixes: string[];
  excludeGlobs: string[];
}

/** 把绝对 denyPaths 与 contextExcludes 相对化到工作区根；不在工作区内的 deny 条目直接跳过。 */
export function relativeExcludes(workspace: string, denyPaths: string[], contextExcludes: string[]): SnapshotDiffExcludes {
  const excludePrefixes: string[] = [];
  const excludeGlobs: string[] = [];
  for (const deny of denyPaths) {
    const rel = path.relative(workspace, deny);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const normalized = rel.split(path.sep).join("/");
    (normalized.includes("*") || normalized.includes("?") ? excludeGlobs : excludePrefixes).push(normalized);
  }
  for (const glob of contextExcludes) {
    (glob.includes("*") || glob.includes("?") ? excludeGlobs : excludePrefixes).push(glob);
  }
  return { excludePrefixes, excludeGlobs };
}

interface TreeEntry {
  size: number;
  mtimeMs: number;
}

interface Change {
  rel: string;
  kind: "added" | "deleted" | "modified";
  oldSize: number;
  newSize: number;
}

/** 简易 glob → 正则：`**` 跨目录段、`*` 单段内、`?` 单字符；其余字符按字面转义。 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

async function walkTree(root: string, options: DiffTreesOptions, budget: { nodes: number }): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  const globs = (options.excludeGlobs ?? []).map(globToRegExp);
  const isExcluded = (rel: string): boolean => {
    if (options.excludePrefixes?.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) return true;
    return globs.some((re) => re.test(rel));
  };
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    if (budget.nodes <= 0) return entries;
    let info;
    try {
      info = await stat(path.join(root, rel));
    } catch {
      continue; // 枚举期消失/无权限：跳过（与快照扫描的容错一致）
    }
    budget.nodes--;
    if (info.isDirectory()) {
      let children: string[];
      try {
        children = await readdir(path.join(root, rel));
      } catch {
        continue;
      }
      for (const child of children) {
        const childRel = rel ? `${rel}/${child}` : child;
        if (isExcluded(childRel)) continue;
        stack.push(childRel);
      }
    } else if (info.isFile() || info.isSymbolicLink()) {
      entries.set(rel, { size: info.size, mtimeMs: info.mtimeMs });
    } else if (!info.isDirectory() && options.whiteoutAsDeleted) {
      // overlayfs whiteout（字符设备）＝删除标记：跳过，等价于该路径不存在
    }
  }
  return entries;
}

/** 单侧缺失文件的 unified diff：`--- /dev/null`（新增）或 `+++ /dev/null`（删除）+ 全文件 hunk。 */
function synthesizeSideDiff(change: Change, content: string): string {
  const header = change.kind === "added"
    ? `diff --git a/${change.rel} b/${change.rel}\n--- /dev/null\n+++ b/${change.rel}\n`
    : `diff --git a/${change.rel} b/${change.rel}\n--- a/${change.rel}\n+++ /dev/null\n`;
  if (content.includes("\0")) return header; // 二进制：只有头（stat 行已另行输出）
  const lines = content.split("\n");
  const count = content.endsWith("\n") ? lines.length - 1 : lines.length;
  if (change.kind === "added") {
    const body = lines.slice(0, count).map((line) => `+${line}`).join("\n");
    return `${header}@@ -0,0 +1,${count} @@\n${body}${count > 0 ? "\n" : ""}`;
  }
  const body = lines.slice(0, count).map((line) => `-${line}`).join("\n");
  return `${header}@@ -1,${count} +0,0 @@\n${body}${count > 0 ? "\n" : ""}`;
}

/** git --no-index 输出绝对路径（Windows 还带引号）；头部元数据行归一为相对路径，与 git-shadow 同形。 */
function normalizeGitFragments(rel: string, stdout: string): string {
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) lines[i] = `diff --git a/${rel} b/${rel}`;
    else if (line.startsWith("--- ")) lines[i] = `--- a/${rel}`;
    else if (line.startsWith("+++ ")) lines[i] = `+++ b/${rel}`;
    else if (line.startsWith("@@")) break; // 进入 hunk，头部结束
    // index / new file mode 等元数据行保持原样
  }
  return lines.join("\n");
}

function runGitDiff(oldPath: string, newPath: string): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--no-index", "--", oldPath, newPath], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) return resolve({ code: 0, stdout });
      const code = typeof error.code === "number" ? error.code : 1;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(null); // git 缺失
      return resolve({ code, stdout });
    });
  });
}

/**
 * 双侧树差异 → stat 摘要 + unified diff 文本；系统无 git 时返回 null（调用方降级）。
 * 输出经 truncateLines(4000) 与 git-shadow 同限。
 */
export async function diffTrees(oldRoot: string, newRoot: string, options: DiffTreesOptions = {}): Promise<string | null> {
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
  const changedCap = options.changedCap ?? 128;
  const maxNodes = options.maxNodes ?? 200_000;
  const budget = { nodes: maxNodes };
  const [before, after] = await Promise.all([walkTree(oldRoot, options, budget), walkTree(newRoot, options, budget)]);

  const changes: Change[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const rel of [...paths].sort((a, b) => a.localeCompare(b))) {
    const oldEntry = before.get(rel);
    const newEntry = after.get(rel);
    if (oldEntry && !newEntry) changes.push({ rel, kind: "deleted", oldSize: oldEntry.size, newSize: 0 });
    else if (!oldEntry && newEntry) changes.push({ rel, kind: "added", oldSize: 0, newSize: newEntry.size });
    else if (oldEntry && newEntry && (oldEntry.size !== newEntry.size || oldEntry.mtimeMs !== newEntry.mtimeMs)) {
      changes.push({ rel, kind: "modified", oldSize: oldEntry.size, newSize: newEntry.size });
    }
  }

  const statLines = changes.map((change) => {
    const marker = change.kind === "added" ? "A" : change.kind === "deleted" ? "D" : "M";
    const size = change.kind === "added" ? change.newSize : change.kind === "deleted" ? change.oldSize : `${change.oldSize} → ${change.newSize}`;
    return `${marker} ${change.rel} (${size} B)`;
  });
  const truncatedNodes = budget.nodes <= 0;
  const truncatedFiles = changes.length > changedCap;
  const textChanges = truncatedFiles ? changes.slice(0, changedCap) : changes;

  // 双侧文件经 git 出 unified diff；新增/删除手工合成（跨平台，不依赖 /dev/null 或 NUL）
  const fragments: string[] = [];
  for (const change of textChanges) {
    const oldPath = path.join(oldRoot, change.rel);
    const newPath = path.join(newRoot, change.rel);
    let fragment: string;
    if (change.kind === "modified") {
      if (change.oldSize > maxFileBytes || change.newSize > maxFileBytes) continue; // 文件过大：仅 stat 行
      const git = await runGitDiff(oldPath, newPath);
      if (git === null) return null; // git 缺失：整体降级
      if (git.code === 1) fragment = normalizeGitFragments(change.rel, git.stdout.trimEnd());
      else if (git.code === 0) continue; // 理论不出现（size/mtime 已判定变更）
      else continue; // git 异常：该文件降级 stat 行
    } else {
      const side = change.kind === "added" ? newPath : oldPath;
      let info;
      try {
        info = await stat(side);
      } catch {
        continue;
      }
      if (info.size > maxFileBytes) continue; // 文件过大：仅 stat 行
      const content = await readFile(side, "utf8");
      fragment = synthesizeSideDiff(change, content).trimEnd();
    }
    if (fragment) fragments.push(fragment);
  }

  const parts: string[] = [];
  if (statLines.length > 0) {
    const summary = [...statLines, ...(truncatedFiles ? [`…（变更文件超限，前 ${changedCap} 个附完整 diff）`] : []), ...(truncatedNodes ? ["…（遍历节点超预算，差异可能不完整）"] : [])];
    parts.push(summary.join("\n"));
  }
  if (fragments.length > 0) parts.push(fragments.join("\n\n"));
  const text = parts.join("\n\n");
  return truncateLines(text, 4000);
}
