/**
 * 轻量符号提取器（0.4.0 Phase 2 §4.1）：基于正则/ctags 规则的 per-language 提取。
 * 定位是"够用导航"——给 code_search / repo_map 提供定义位置与签名摘要，
 * 不追求编译器级精度；真相永远是文件本身，agent 读原文仍走 read_file。
 *
 * 每条规则是"单行正则 → 符号"，行区间 endLine 取下一个符号 startLine-1
 * （最后一个符号到文件尾），是启发式近似，不做括号配对。
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "struct"
  | "enum"
  | "trait"
  | "impl"
  | "constant";

export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  /** 1 起始，闭区间 */
  startLine: number;
  endLine: number;
  /** 签名摘要：匹配行去首尾空白后截取前 120 字符 */
  signature: string;
}

/** 单文件符号数上限：防御病态生成文件把索引撑爆。 */
export const MAX_SYMBOLS_PER_FILE = 200;
/** 参与提取的源文件大小上限（字节）。 */
export const MAX_EXTRACT_FILE_BYTES = 1_048_576;

const SIGNATURE_LIMIT = 120;

/** 按扩展名识别语言；不支持的返回 undefined（只进文件清单，不提符号）。 */
export function languageForPath(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "ts": case "tsx": case "mts": case "cts": return "typescript";
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "py": case "pyi": return "python";
    case "go": return "go";
    case "rs": return "rust";
    case "c": case "h": return "c";
    case "cpp": case "cc": case "cxx": case "hpp": case "hh": case "hxx": return "cpp";
    case "java": return "java";
    case "cs": return "csharp";
    default: return undefined;
  }
}

interface RawMatch {
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string;
}

interface LanguageRule {
  pattern: RegExp;
  /** 从捕获组取名字（默认第 1 组）。 */
  nameGroup?: number;
  kind: SymbolKind | ((match: RegExpExecArray, line: string) => SymbolKind);
  /** 额外否决条件：返回 true 丢弃该匹配。 */
  reject?: (match: RegExpExecArray, line: string) => boolean;
}

const C_KEYWORDS = new Set([
  "if", "for", "while", "switch", "return", "sizeof", "catch", "do", "else",
  "typedef", "static", "extern", "inline", "const", "volatile", "register",
]);

const JS_METHOD_RE = /^\s+(?:public|private|protected|static|async|override|readonly|get|set)\s+(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(/;

/** TS/JS 共用一套规则：导出声明 + 类方法（要求可见性/修饰词，避免把 if( 当方法）。 */
const TYPESCRIPT_RULES: LanguageRule[] = [
  { pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, kind: "function" },
  { pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { pattern: /^\s*(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]/, kind: "constant" },
  { pattern: JS_METHOD_RE, kind: "method" },
];

const PYTHON_RULES: LanguageRule[] = [
  {
    pattern: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
    nameGroup: 2,
    // 缩进的 def 视作方法（ctags 的 scope 语义近似）
    kind: (match) => ((match[1] ?? "").length > 0 ? "method" : "function"),
  },
  { pattern: /^(\s*)class\s+([A-Za-z_]\w*)/, nameGroup: 2, kind: "class" },
];

const GO_RULES: LanguageRule[] = [
  { pattern: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/, kind: "method" },
  { pattern: /^func\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
  { pattern: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "struct" },
  { pattern: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "interface" },
  { pattern: /^type\s+([A-Za-z_]\w*)\s+/, kind: "type" },
];

const RUST_RULES: LanguageRule[] = [
  { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
  { pattern: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
  { pattern: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
  { pattern: /^\s*(?:pub\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
  {
    // impl 块：名字取被 impl 的类型（impl Trait for Type 取 Type）
    pattern: /^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:(?:[A-Za-z_]\w*(?:::\w+)*)[^{]*?\s+for\s+)?([A-Za-z_]\w*)/,
    kind: "impl",
  },
  { pattern: /^\s*(?:pub\s+)?(?:const|static)\s+([A-Za-z_]\w*)/, kind: "constant" },
];

/** C/C++ 函数定义：有返回类型前缀 + 形参表 + 行尾不以 ; 结束（排除声明），名字不在控制关键字内。 */
const C_FUNCTION_RE = /^\s*(?:[A-Za-z_][\w:<>,*&\[\]~ ]*?\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:->[^{;]+)?\{?\s*$/;
const C_FAMILY_RULES: LanguageRule[] = [
  {
    pattern: C_FUNCTION_RE,
    kind: "function",
    reject: (match, line) =>
      C_KEYWORDS.has(match[1] ?? "") ||
      line.trimEnd().endsWith(";") ||
      /^\s*(#|\/\/)/.test(line),
  },
  { pattern: /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)\s*\{/, kind: "struct" },
  { pattern: /^\s*(?:typedef\s+)?enum\s+([A-Za-z_]\w*)\s*\{/, kind: "enum" },
  { pattern: /^\s*(?:template\s*<[^>]*>\s*)?class\s+([A-Za-z_]\w*)/, kind: "class" },
];

const JAVA_RULES: LanguageRule[] = [
  { pattern: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_]\w*)/, kind: "class" },
  { pattern: /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/, kind: "interface" },
  { pattern: /^\s*(?:public\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
  {
    // 方法：要求至少一个修饰词，返回类型可空（构造器）；排除控制语句
    pattern: /^\s+(?:public|private|protected|static|final|synchronized|abstract|default|native)[\w<>\[\],.?\s]*?\s([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?\{?\s*$/,
    kind: "method",
    reject: (match, line) =>
      C_KEYWORDS.has(match[1] ?? "") || line.trimEnd().endsWith(";") || /\b(new|return)\s*$/.test(line.slice(0, line.indexOf(match[1] ?? ""))),
  },
];

const CSHARP_RULES: LanguageRule[] = [
  { pattern: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|abstract\s+|sealed\s+|static\s+|partial\s+)*class\s+([A-Za-z_]\w*)/, kind: "class" },
  { pattern: /^\s*(?:public\s+|internal\s+)?interface\s+([A-Za-z_]\w*)/, kind: "interface" },
  { pattern: /^\s*(?:public\s+|internal\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
  { pattern: /^\s*(?:public\s+|internal\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
  {
    pattern: /^\s+(?:public|private|protected|internal|static|async|virtual|override|sealed|readonly|partial|extern)[\w<>\[\],.?\s]*?\s([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:where\s+[^{]+)?\{?\s*$/,
    kind: "method",
    reject: (match, line) => C_KEYWORDS.has(match[1] ?? "") || line.trimEnd().endsWith(";"),
  },
];

const RULES: Record<string, LanguageRule[]> = {
  typescript: TYPESCRIPT_RULES,
  javascript: TYPESCRIPT_RULES,
  python: PYTHON_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
  c: C_FAMILY_RULES,
  cpp: C_FAMILY_RULES,
  java: JAVA_RULES,
  csharp: CSHARP_RULES,
};

/**
 * 从源码文本提取符号。逐行匹配（O(行数)），无回溯型正则；
 * 超过 MAX_SYMBOLS_PER_FILE 截断（索引是缓存，截断不算丢真相）。
 */
export function extractSymbols(language: string, text: string): SymbolRecord[] {
  const rules = RULES[language];
  if (!rules) return [];
  const lines = text.split("\n");
  const raw: RawMatch[] = [];
  for (let index = 0; index < lines.length && raw.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length > 2_000) continue; // 跳过压缩/混淆的长行
    for (const rule of rules) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      if (rule.reject?.(match, line)) continue;
      const name = match[rule.nameGroup ?? 1];
      if (!name) continue;
      const kind = typeof rule.kind === "function" ? rule.kind(match, line) : rule.kind;
      const signature = line.trim().slice(0, SIGNATURE_LIMIT);
      raw.push({ name, kind, line: index + 1, signature });
      break;
    }
  }
  return raw.map((entry, index) => ({
    name: entry.name,
    kind: entry.kind,
    startLine: entry.line,
    endLine: index + 1 < raw.length ? (raw[index + 1]?.line ?? entry.line) - 1 : lines.length,
    signature: entry.signature,
  }));
}
