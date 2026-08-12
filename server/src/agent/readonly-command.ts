/**
 * 只读 bash 命令判定（权限自动放行）：
 * `cd x && echo ... && head ... && ls ... 2>/dev/null | head` 这类纯只读探查链
 * 在 ask/acceptEdits/review 权限模式下自动放行，无需人工批准；「总是允许」规则
 * 因 SHELL_CONTROL_CHARS 对含 && 的命令回退整串精确匹配而无法命中，这里补上
 * 结构化的只读判定。
 *
 * 判定是保守的：任何无法证明只读的形态一律拒绝（转人工审批）。单趟词法扫描，
 * 引号感知——单引号内内容不解释（POSIX），双引号内的 `$(`/反引号仍会执行必须拒绝。
 */

/** POSIX + Windows(cmd) 共用的只读命令白名单：命令名必须是裸名（无路径分隔符）。 */
const READONLY_COMMANDS = new Set([
  "cd", "echo", "printf", "pwd", "ls", "find", "cat", "head", "tail", "wc", "sort", "uniq",
  "cut", "tr", "grep", "egrep", "fgrep", "sed", "diff", "stat", "file", "du", "df", "date",
  "dirname", "basename", "realpath", "true", "false", "clear", "more", "type", "which",
  "help", "alias", "hash",
  // Windows cmd 常用只读命令（与 POSIX 无写命令名冲突）
  "dir", "findstr", "where", "cls",
]);

/**
 * git 只读子命令白名单：第二 token 必须是其中之一且不以 `-` 开头
 * （`git -C ...`、`git -c ...` 等选项形态保守拒绝）。
 */
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "describe", "shortlog",
  "blame", "grep", "check-ignore", "symbolic-ref", "for-each-ref", "count-objects",
  "help", "version", "--version", "--help",
]);

/** find 的执行/删除形态（会执行任意命令或写文件）。 */
const FIND_WRITE_PATTERN = /-exec(dir)?\b|-ok\b|-delete\b/;
/** sed 原地编辑。 */
const SED_INPLACE_PATTERN = /\s-i\b|--in-place/;
/** sort 输出到文件。 */
const SORT_OUTPUT_PATTERN = /\s-o\b|--output/;
/** date 设置系统时间。 */
const DATE_SET_PATTERN = /\s-s\b|--set/;

const isSpace = (ch: string | undefined): boolean => ch === " " || ch === "\t";

/**
 * `>` 重定向仅允许写入 /dev/null 的形式（`>/dev/null`、`1>/dev/null`、`2>/dev/null`，
 * 允许中间空白）；`>>`、`>&`、`>|`、其他 fd（如 `3>`）一律拒绝。
 * cmd[i] 必须是 `>`。
 */
function isDevNullRedirect(cmd: string, i: number): boolean {
  const next = cmd[i + 1];
  if (next === ">" || next === "&" || next === "|") return false;
  const prev = i > 0 ? cmd[i - 1] : undefined;
  if (prev === "1" || prev === "2") {
    // 前导 fd 数字：`12>` 等多位数 fd 拒绝
    const prev2 = i > 1 ? cmd[i - 2] : undefined;
    if (prev2 !== undefined && prev2 >= "0" && prev2 <= "9") return false;
  } else if (prev !== undefined && prev >= "0" && prev <= "9") {
    return false;
  }
  let j = i + 1;
  while (j < cmd.length && isSpace(cmd[j])) j += 1;
  if (!cmd.startsWith("/dev/null", j)) return false;
  const after = cmd[j + 9];
  // 词边界：行尾或分隔符/空白；`/dev/null` 后紧跟 `>`（如 /dev/null>file）拒绝
  return after === undefined || isSpace(after) || after === "&" || after === "|" || after === ";" ||
    after === "\n" || after === "\r";
}

/** 段内第一个 token（命令名），引号感知：`"ls"` 去引号，引号内容并入 token（含空白则查表失败）。 */
function extractCommandName(segment: string): string {
  let i = 0;
  const n = segment.length;
  while (i < n && isSpace(segment[i])) i += 1;
  let token = "";
  for (; i < n; i += 1) {
    const ch = segment[i]!;
    if (isSpace(ch)) break;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      for (; i < n; i += 1) {
        const c = segment[i]!;
        if (c === "\\") {
          token += c;
          if (i + 1 < n) {
            token += segment[i + 1]!;
            i += 1;
          }
          continue;
        }
        if (c === quote) break;
        token += c;
      }
      continue;
    }
    token += ch;
  }
  return token;
}

/** git 特例：第二个 token 必须是只读子命令（且不以 `-` 开头）。 */
function isReadonlyGit(segment: string): boolean {
  let i = 0;
  const n = segment.length;
  while (i < n && isSpace(segment[i])) i += 1;
  while (i < n && !isSpace(segment[i])) i += 1;
  while (i < n && isSpace(segment[i])) i += 1;
  let sub = "";
  for (; i < n; i += 1) {
    const ch = segment[i]!;
    if (isSpace(ch)) break;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      for (; i < n; i += 1) {
        const c = segment[i]!;
        if (c === "\\") { i += 1; continue; }
        if (c === quote) break;
      }
      continue;
    }
    sub += ch;
  }
  if (sub.startsWith("-")) return false;
  return GIT_READONLY_SUBCOMMANDS.has(sub);
}

/** 命令名之外的参数级拦截（白名单内的命令存在写形态时）。 */
function checkArgs(tool: string, segment: string): boolean {
  switch (tool) {
    case "find": return !FIND_WRITE_PATTERN.test(segment);
    case "sed": return !SED_INPLACE_PATTERN.test(segment);
    case "sort": return !SORT_OUTPUT_PATTERN.test(segment);
    case "date": return !DATE_SET_PATTERN.test(segment);
    default: return true;
  }
}

/** 检查一个命令段：空段放行，否则命令名必须命中白名单且无写形态。 */
function checkSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return true;
  const name = extractCommandName(segment);
  if (name.length === 0) return false;
  // 裸命令名限定：路径形式（含工作区脚本）与环境变量赋值前缀一律拒绝
  if (name.includes("/") || name.includes("=")) return false;
  if (name === "git") return isReadonlyGit(segment);
  if (!READONLY_COMMANDS.has(name)) return false;
  return checkArgs(name, segment);
}

/**
 * 判断 bash 命令是否为可自动放行的只读探查链。
 * 规则（全部满足才放行）：
 * - 无命令替换（`$(`、反引号，含双引号内）；
 * - 无输入/输出重定向（`>` 仅限 /dev/null，`<` 一律拒绝）；
 * - 按 `&&`、`||`、`;`、`|`、`&`、换行分段后，每一段都是白名单命令的只读形态。
 */
export function isReadOnlyCommand(cmd: string): boolean {
  let state: "normal" | "single" | "double" = "normal";
  let segmentStart = 0;
  const n = cmd.length;
  for (let i = 0; i < n; i += 1) {
    const ch = cmd[i]!;
    if (state === "single") {
      if (ch === "'") state = "normal";
      continue;
    }
    if (state === "double") {
      if (ch === "\\") { i += 1; continue; }
      if (ch === '"') { state = "normal"; continue; }
      // 双引号内的命令替换仍会执行
      if (ch === "$" && cmd[i + 1] === "(") return false;
      if (ch === "`") return false;
      continue;
    }
    // normal
    if (ch === "\\") { i += 1; continue; }
    if (ch === "'") { state = "single"; continue; }
    if (ch === '"') { state = "double"; continue; }
    if (ch === "$" && cmd[i + 1] === "(") return false;
    if (ch === "`") return false;
    if (ch === "<") return false;
    if (ch === ">") {
      if (!isDevNullRedirect(cmd, i)) return false;
      continue;
    }
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n" || ch === "\r") {
      if (!checkSegment(cmd.slice(segmentStart, i))) return false;
      // 跳过成对分隔符（&& / ||）与单字符分隔符
      i += 1;
      if (cmd[i] === "&" || cmd[i] === "|") i += 1;
      segmentStart = i;
      continue;
    }
  }
  return checkSegment(cmd.slice(segmentStart));
}
