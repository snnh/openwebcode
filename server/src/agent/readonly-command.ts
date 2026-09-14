/**
 * 只读 bash 命令判定（权限自动放行）：
 * `cd x && echo ... && head ... && ls ... 2>/dev/null | head` 这类纯只读探查链
 * 在 ask/acceptEdits/review 权限模式下自动放行，无需人工批准；「总是允许」规则
 * 因 SHELL_CONTROL_CHARS 对含 && 的命令回退整串精确匹配而无法命中，这里补上
 * 结构化的只读判定。
 *
 * 判定是保守的：任何无法证明只读的形态一律拒绝（转人工审批）。单趟词法扫描，
 * 引号感知——单引号内内容不解释（POSIX），双引号内的 `$(`/反引号仍会执行必须拒绝。
 *
 * Shell 语义门禁：自动放行仅按 POSIX sh 语义判定。cmd 不认 `\` 转义与单引号、
 * pwsh 的转义符是反引号——非 sh 形态（cmd/pwsh）一律转人工，防止「按 POSIX 判定
 * 安全、按 cmd 实际执行出第二条命令」的语法分歧绕过。
 */

/** 生效 shell 的词法形态（shell-detect ResolvedShell.flavor 的子集语义）。 */
export type ReadonlyShellFlavor = "sh" | "pwsh" | "cmd";

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

/** find 的执行/写文件形态（-exec/-ok 执行任意命令；-delete 删除；-fprint/-fprintf/-fls 写任意文件）。 */
const FIND_WRITE_PATTERN = /-exec(dir)?\b|-ok(dir)?\b|-delete\b|-fls\b|-fprint(f)?\b/;
/** git 只读子命令中仍会执行外部程序或写文件的选项（--ext-diff/--textconv 执行 .git/config 配置的命令；--output 写文件）。 */
const GIT_DANGEROUS_PATTERN = /--(ext-diff|textconv|output)(?=[\s=]|$)/;
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

/**
 * 段内词法切词（POSIX 语义）：单引号字面量；双引号内 `\` 仅转义 `"` `\` `$` 反引号；
 * 词外 `\` 转义下一字符。引号不闭合返回 undefined（保守拒绝）。
 */
function tokenizeShellWords(segment: string): string[] | undefined {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let state: "normal" | "single" | "double" = "normal";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (state === "single") {
      if (ch === "'") state = "normal";
      else cur += ch;
      continue;
    }
    if (state === "double") {
      if (ch === "\"") { state = "normal"; continue; }
      if (ch === "\\" && i + 1 < segment.length && "\"\\$`".includes(segment[i + 1]!)) { cur += segment[i + 1]!; i += 1; continue; }
      cur += ch;
      continue;
    }
    if (isSpace(ch)) {
      if (has) { tokens.push(cur); cur = ""; has = false; }
      continue;
    }
    if (ch === "'") { state = "single"; has = true; continue; }
    if (ch === "\"") { state = "double"; has = true; continue; }
    if (ch === "\\") {
      if (i + 1 >= segment.length) return undefined;
      cur += segment[i + 1]!;
      i += 1;
      has = true;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (state !== "normal") return undefined;
  if (has) tokens.push(cur);
  return tokens;
}

/** sed 选项白名单（单 token 形态）；其余选项一律保守拒绝（-f/--file 脚本来自文件无法静态判定；-i 原地写）。 */
const SED_SAFE_SHORT_OPTIONS = /^-[nrEszub]+$/;
const SED_SAFE_LONG_OPTIONS = new Set([
  "--quiet", "--silent", "--regexp-extended", "--separate", "--posix",
  "--null-data", "--unbuffered", "--debug", "--follow-symlinks", "--sandbox",
]);

/**
 * sed 脚本只读判定：扫描脚本命令流，拦截会执行外部命令或读写文件的形态——
 * `e`（执行 shell）、`r`/`R`（读文件进输出，越权信息泄漏）、`w`/`W`（写文件）、
 * `s` 命令的 `e`/`w` flag。解析不确定时一律保守拒绝。
 * GNU 单行式 a/i/c 的文本吞至行尾；`;` 若被实现当文本则无害、若当分隔符则继续扫描，两向安全。
 */
function sedScriptReadonly(script: string): boolean {
  const n = script.length;
  let i = 0;
  let depth = 0;
  const isBlank = (c: string | undefined): boolean => c === " " || c === "\t";
  // script[i] 是开界符：跳到未转义的闭界符之后（`\\` 跳过下一字符）
  const skipDelimited = (delim: string): boolean => {
    i += 1;
    while (i < n) {
      const ch = script[i]!;
      if (ch === "\\") { i += 2; continue; }
      i += 1;
      if (ch === delim) return true;
    }
    return false;
  };
  // 跳过地址（0,/re/、$、+N、~N、数字、/re/、\crec）至多两段（addr1,addr2），失败返回 false
  const skipAddresses = (): boolean => {
    for (let part = 0; part < 2; part += 1) {
      while (i < n && isBlank(script[i])) i += 1;
      const ch = script[i];
      if (ch === undefined) return true;
      if (ch >= "0" && ch <= "9") { while (i < n && script[i]! >= "0" && script[i]! <= "9") i += 1; }
      else if (ch === "$") i += 1;
      else if (ch === "+" || ch === "~") { i += 1; while (i < n && script[i]! >= "0" && script[i]! <= "9") i += 1; }
      else if (ch === "/") { if (!skipDelimited("/")) return false; }
      else if (ch === "\\") {
        // GNU \%re% 形式：下一个字符是自定义界符
        if (i + 1 >= n) return false;
        const delim = script[i + 1]!;
        i += 1;
        if (!skipDelimited(delim)) return false;
      } else return true; // 非地址起始字符：交给命令判定
      while (i < n && isBlank(script[i])) i += 1;
      if (script[i] !== ",") return true;
      i += 1; // 区间第二段
    }
    return true;
  };
  while (true) {
    while (i < n && (script[i] === ";" || script[i] === "\n" || isBlank(script[i]))) i += 1;
    if (i >= n) return depth === 0;
    const ch = script[i]!;
    if (ch === "#") { while (i < n && script[i] !== "\n") i += 1; continue; }
    if (ch === "}") {
      if (depth === 0) return false;
      depth -= 1;
      i += 1;
      continue;
    }
    if (!skipAddresses()) return false;
    while (i < n && isBlank(script[i])) i += 1;
    if (script[i] === "!") { i += 1; while (i < n && isBlank(script[i])) i += 1; }
    const cmd = script[i];
    if (cmd === undefined) return false;
    i += 1;
    if (cmd === "e" || cmd === "r" || cmd === "R" || cmd === "w" || cmd === "W") return false;
    if (cmd === "{") { depth += 1; continue; }
    if (cmd === "s") {
      const delim = script[i];
      if (delim === undefined || delim === "\n" || delim === "\\") return false;
      if (!skipDelimited(delim)) return false; // pattern
      if (!skipDelimited(delim)) return false; // replacement
      // flags 至段尾：仅允许数字/g/p/i/I/m/M 与空白；e/w/W 执行或写文件
      while (i < n && script[i] !== ";" && script[i] !== "\n" && script[i] !== "}") {
        const flag = script[i]!;
        if (flag === "e" || flag === "w" || flag === "W") return false;
        if (!isBlank(flag) && !/[0-9gpIiMm]/.test(flag)) return false;
        i += 1;
      }
      continue;
    }
    if (cmd === "y") {
      const delim = script[i];
      if (delim === undefined || delim === "\n" || delim === "\\") return false;
      if (!skipDelimited(delim)) return false;
      if (!skipDelimited(delim)) return false;
      continue;
    }
    if (cmd === "a" || cmd === "i" || cmd === "c") {
      while (i < n && script[i] !== "\n" && script[i] !== ";") i += 1;
      continue;
    }
    if (cmd === ":" || cmd === "b" || cmd === "t" || cmd === "T") {
      while (i < n && script[i] !== ";" && script[i] !== "\n" && !isBlank(script[i])) i += 1;
      continue;
    }
    // 纯输出/模式空间操作命令
    if ("dDgGhHlnNpPqQxXzZFv=".includes(cmd)) continue;
    return false;
  }
}

/** sed 参数级判定：选项白名单 + 全部脚本的命令流扫描；脚本缺失/形态不明保守拒绝。 */
function isReadonlySed(segment: string): boolean {
  const tokens = tokenizeShellWords(segment);
  if (!tokens || tokens.length === 0 || tokens[0] !== "sed") return false;
  const scripts: string[] = [];
  let scriptSeen = false;
  for (let k = 1; k < tokens.length; k += 1) {
    const t = tokens[k]!;
    if (t === "-e" || t === "--expression") {
      const value = tokens[k + 1];
      if (value === undefined) return false;
      scripts.push(value);
      scriptSeen = true;
      k += 1;
      continue;
    }
    if (t.startsWith("--expression=")) { scripts.push(t.slice("--expression=".length)); scriptSeen = true; continue; }
    if (t === "-f" || t === "--file" || t.startsWith("--file=")) return false;
    if (t === "--") {
      if (!scriptSeen) {
        const value = tokens[k + 1];
        if (value === undefined) return false;
        scripts.push(value);
      }
      break; // `--` 之后均为输入文件
    }
    if (t.startsWith("-") && t !== "-") {
      if (SED_SAFE_SHORT_OPTIONS.test(t) || SED_SAFE_LONG_OPTIONS.has(t) || /^--line-length=\d+$/.test(t) || /^-l\d*$/.test(t)) continue;
      return false;
    }
    if (!scriptSeen) { scripts.push(t); scriptSeen = true; }
    // 其余非选项 token 为输入文件，只读
  }
  if (scripts.length === 0) return false;
  return scripts.every(sedScriptReadonly);
}

/** 命令名之外的参数级拦截（白名单内的命令存在写形态时）。 */
function checkArgs(tool: string, segment: string): boolean {
  switch (tool) {
    case "find": return !FIND_WRITE_PATTERN.test(segment);
    case "sed": return isReadonlySed(segment);
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
  if (name === "git") return isReadonlyGit(segment) && !GIT_DANGEROUS_PATTERN.test(segment);
  if (!READONLY_COMMANDS.has(name)) return false;
  return checkArgs(name, segment);
}

/**
 * 判断 bash 命令是否为可自动放行的只读探查链。
 * 规则（全部满足才放行）：
 * - 生效 shell 是 POSIX sh 形态（cmd/pwsh 转义与引号规则不同，一律转人工）；
 * - 无命令替换（`$(`、反引号，含双引号内）；
 * - 无输入/输出重定向（`>` 仅限 /dev/null，`<` 一律拒绝）；
 * - 按 `&&`、`||`、`;`、`|`、`&`、换行分段后，每一段都是白名单命令的只读形态。
 */
export function isReadOnlyCommand(cmd: string, shell: ReadonlyShellFlavor = "sh"): boolean {
  if (shell !== "sh") return false;
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
