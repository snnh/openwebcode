/**
 * unified diff 解析与 hunk 级还原（0.5.0 Phase 1b）：
 * - 只依赖文本格式本身，不引第三方 diff 库；Monaco 只做可视化。
 * - 解析 `git diff` 输出为 文件 → hunk 结构；hunk 行保留原前缀（' ' / '-' / '+' / '\'）。
 * - revertHunks 把指定 hunk 的"新侧"替换回"旧侧"（内容写回方案）：
 *   SCM 未提交改动 vs HEAD 的拒绝、检查点对比的"恢复到此 hunk"都归一到这一操作，
 *   写回由调用方走 server 写端点（write_file 权限链），本模块不触网。
 */

interface DiffHunk {
  /** 1-based 旧侧起始行（旧侧 0 行时为插入点前行） */
  oldStart: number;
  oldLines: number;
  /** 1-based 新侧起始行 */
  newStart: number;
  newLines: number;
  /** 原始 @@ 头行（含尾部上下文说明） */
  header: string;
  /** hunk 内容行，保留前缀字符 */
  lines: string[];
}

export interface DiffFile {
  /** 旧侧路径（新文件时为空字符串） */
  oldPath: string;
  /** 新侧路径（删除文件时为空字符串） */
  newPath: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
}

/** 去掉 `a/`、`b/` 前缀；/dev/null 返回空串 */
function stripDiffPath(raw: string): string {
  const value = raw.trim().replace(/^"|"$/g, "");
  if (value === "/dev/null") return "";
  return value.replace(/^[ab]\//, "");
}

/**
 * 解析 unified diff 文本。非 diff 内容（stat 摘要、截断标记等）被跳过；
 * 文本中不含任何 diff 文件段时返回空数组（调用方按摘要模式降级）。
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = text.split("\n");
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;

  const ensureFile = (): DiffFile => {
    if (!file) {
      file = { oldPath: "", newPath: "", isNew: false, isDeleted: false, hunks: [] };
      files.push(file);
    }
    return file;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = { oldPath: "", newPath: "", isNew: false, isDeleted: false, hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (line.startsWith("new file mode")) {
      ensureFile().isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      ensureFile().isDeleted = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      // hunk 体内的删除行以单个 '-' 开头，"--- " 三个连字符只会出现在文件头
      hunk = undefined;
      ensureFile().oldPath = stripDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      hunk = undefined;
      ensureFile().newPath = stripDiffPath(line.slice(4));
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        header: line,
        lines: [],
      };
      ensureFile().hunks.push(hunk);
      continue;
    }
    if (hunk) {
      const prefix = line[0];
      if (prefix === " " || prefix === "-" || prefix === "+" || prefix === "\\") {
        hunk.lines.push(line);
        continue;
      }
      // 非 hunk 行（如截断标记）：当前 hunk 结束
      hunk = undefined;
    }
  }
  return files;
}

/** hunk 的新侧文本（上下文 + 新增行，去前缀） */
export function hunkNewText(hunk: DiffHunk): string[] {
  return hunk.lines.filter((line) => line[0] === " " || line[0] === "+").map((line) => line.slice(1));
}

/** hunk 的旧侧文本（上下文 + 删除行，去前缀） */
export function hunkOldText(hunk: DiffHunk): string[] {
  return hunk.lines.filter((line) => line[0] === " " || line[0] === "-").map((line) => line.slice(1));
}

/** 在 content 行数组中定位 block：优先 hint 位置，失败则全文搜索首个精确匹配 */
function locateBlock(lines: string[], block: string[], hint: number): number {
  const matches = (at: number): boolean => {
    if (at < 0 || at + block.length > lines.length) return false;
    for (let index = 0; index < block.length; index++) {
      if (lines[at + index] !== block[index]) return false;
    }
    return true;
  };
  if (matches(hint)) return hint;
  for (let at = 0; at + block.length <= lines.length; at++) {
    if (matches(at)) return at;
  }
  return -1;
}

/**
 * hunk 还原失败：稳定 code 供 UI 层映射为 i18n 文案（本模块不依赖 i18n）。
 * message 只承载英文技术细节（下标 / @@ 头），不直接上屏。
 */
export class HunkRevertError extends Error {
  readonly code: "invalid-hunk-index" | "hunk-content-mismatch";
  constructor(code: "invalid-hunk-index" | "hunk-content-mismatch", detail: string) {
    super(detail);
    this.name = "HunkRevertError";
    this.code = code;
  }
}

/**
 * 把 file 中指定下标的 hunk 还原（新侧 → 旧侧），返回新的文件内容。
 * content 是"新侧"完整文件内容（当前磁盘内容）。多个 hunk 按行号自底向上应用，
 * 避免相互位移；hunk 定位优先用 newStart，与当前内容不符时全文精确匹配，
 * 仍不匹配则抛 HunkRevertError（文件在 diff 生成后又被改动），由调用方按 code 映射提示并保留原状。
 */
export function revertHunks(content: string, file: DiffFile, hunkIndexes: number[]): string {
  const lines = content.split("\n");
  const ordered = [...hunkIndexes].sort((a, b) => (file.hunks[b]?.newStart ?? 0) - (file.hunks[a]?.newStart ?? 0));
  for (const index of ordered) {
    const hunk = file.hunks[index];
    if (!hunk) throw new HunkRevertError("invalid-hunk-index", `invalid hunk index: ${index}`);
    const newText = hunkNewText(hunk);
    const oldText = hunkOldText(hunk);
    // newLines=0 的纯删除 hunk：按 unified diff 约定 newStart 是"删除点之前的行号"，插入点即其下标
    const hint = newText.length === 0 ? hunk.newStart : hunk.newStart - 1;
    let at = locateBlock(lines, newText, hint);
    if (at < 0 && newText.length === 0) {
      // 纯删除 hunk 无法用空块定位：按行号插入
      at = hint <= lines.length ? hint : -1;
    }
    if (at < 0) throw new HunkRevertError("hunk-content-mismatch", `hunk does not match current file content: ${hunk.header}`);
    lines.splice(at, newText.length, ...oldText);
  }
  return lines.join("\n");
}

/** 由当前（新侧）内容反推 diff 旧侧全文：还原全部 hunk */
export function reconstructOriginal(content: string, file: DiffFile): string {
  return revertHunks(content, file, file.hunks.map((_, index) => index));
}
