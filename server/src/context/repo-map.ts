import type { CoreClientLike } from "../core-client.js";
import type { RepoMapSymbolFile } from "../index/index-manager.js";
import { isPathExcluded } from "./context-manager.js";
import { estimateTokens } from "./model-profile.js";

/**
 * 静态 repo map 生成器（0.4.0 Phase 1 §4.1）：目录树（深度/条目有界）+ 关键文件提示。
 * 符号索引属 Phase 2，此处不做任何语言解析。
 *
 * 扫描必须走 Core 的有界原语 fs.scan（节点/字节预算、no-follow），Node 不直接遍历工作区。
 * 排除规则 = 默认忽略约定（node_modules/.git/dist/build 等，对齐 snapshots 的排除清单）
 * + 会话 contextExcludes（复用 isPathExcluded；排除不是安全边界，只影响上下文组装）。
 */

/** repo map 显式 token 预算默认值（计划 §4.1：默认 2k，会话可配）。 */
export const DEFAULT_REPO_MAP_BUDGET = 2_048;
/** 单次扫描节点上限：分页拉取到此为止，超出如实标注 truncated。 */
const SCAN_NODE_CAP = 6_000;
/** fs.scan 单页条目数（core RPC 上限 256，见 rpc.c OWC_FS_SCAN_MAX_LIMIT）。 */
const SCAN_PAGE_LIMIT = 256;
/** 目录树最大深度（预算不足时会逐级收缩）。 */
const DEFAULT_MAX_DEPTH = 6;
/** 目录缓存 TTL：根目录 mtime 未变且未过期时不重扫（turn 间无变化零扫描）。 */
const CACHE_TTL_MS = 30_000;

/** 默认忽略约定：与 snapshots/git-shadow.ts 的排除清单同族，外加常见构建产物目录。 */
const REPO_MAP_DEFAULT_EXCLUDES: readonly string[] = [
  ".git", ".owc", ".openwebcode", "node_modules",
  "dist", "build", "build-*", "out", "coverage", "target",
  ".next", ".cache", "__pycache__", ".venv", "_CPack_Packages",
];

/** 关键文件提示：根级 README/manifest 类文件，帮助 agent 定位项目入口。 */
const KEY_FILE_EXACT = new Set([
  "package.json", "tsconfig.json", "cmakelists.txt", "cargo.toml", "pyproject.toml",
  "go.mod", "go.sum", "gemfile", "pom.xml", "build.gradle", "makefile", "dockerfile",
]);
const KEY_FILE_PATTERN = /^(readme|license|licence|changelog|contributing)(\.|$)|\.(sln|csproj|xcodeproj)$/i;
const KEY_FILE_CAP = 12;

/** 索引可用时附符号摘要的关键文件数与每文件符号数上限（Phase 2 §4.1）。 */
const SYMBOL_FILE_CAP = 15;
const SYMBOL_NAMES_CAP = 8;

/** Phase 2：索引符号摘要提供者；返回 undefined 表示索引不可用 → 保持静态树降级。 */
type RepoMapSymbolProvider = (cwd: string) => Promise<RepoMapSymbolFile[] | undefined>;

interface RepoMapEntry {
  path: string;
  type: "file" | "directory" | "other";
  size: number;
}

interface RepoMapOptions {
  sessionId: string;
  cwd: string;
  /** token 预算；缺省 DEFAULT_REPO_MAP_BUDGET。 */
  budget?: number;
  /** 会话 contextExcludes；与默认忽略约定叠加。 */
  excludes?: readonly string[];
  maxDepth?: number;
}

interface RepoMapResult {
  /** 渲染后的摘要文本（不含段标题；调用方自行包装为提示词段）。 */
  text: string;
  /** estimateTokens(text)，用于 Context 面板 repoMap 段归因。 */
  tokens: number;
  /** 预算/节点上限导致内容被裁剪时为 true，text 尾部有如实标注。 */
  truncated: boolean;
  /** true 表示本次命中缓存，未重新扫描。 */
  cached: boolean;
  /** 实际纳入树中的条目数（排除后）。 */
  entryCount: number;
}

interface ScanCacheEntry {
  rootModifiedMs: number;
  scannedAt: number;
  entries: RepoMapEntry[];
  scanTruncated: boolean;
  /** 渲染缓存：键为预算/排除/深度组合，命中则连渲染都跳过。 */
  renders: Map<string, RepoMapResult>;
}

interface DirNode {
  dirs: Map<string, DirNode>;
  files: string[];
}

export class RepoMapGenerator {
  private readonly scans = new Map<string, ScanCacheEntry>();
  /** Phase 2：可选的索引符号提供者（IndexManager.symbolSummary）。 */
  private symbolProvider?: RepoMapSymbolProvider;

  constructor(private readonly core: CoreClientLike) {}

  setSymbolProvider(provider: RepoMapSymbolProvider): void {
    this.symbolProvider = provider;
  }

  async generate(options: RepoMapOptions): Promise<RepoMapResult> {
    const budget = Math.max(64, Math.floor(options.budget ?? DEFAULT_REPO_MAP_BUDGET));
    const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH));
    const excludes = [...REPO_MAP_DEFAULT_EXCLUDES, ...(options.excludes ?? [])];
    const scan = await this.scan(options.sessionId, options.cwd);
    // 索引可用时取符号摘要（最近修改优先）；失败/未建一律降级为纯静态树
    let symbolFiles: RepoMapSymbolFile[] | undefined;
    if (this.symbolProvider) {
      try {
        symbolFiles = await this.symbolProvider(options.cwd);
      } catch {
        symbolFiles = undefined;
      }
    }
    // 渲染缓存键纳入符号指纹：索引刷新（最新 mtime/文件数变化）后旧渲染不复用
    const symbolFingerprint = symbolFiles ? `${symbolFiles.length}:${symbolFiles[0]?.modifiedMs ?? 0}` : "none";
    const renderKey = `${budget}|${maxDepth}|${excludes.join("|")}|${symbolFingerprint}`;
    const cachedRender = scan.renders.get(renderKey);
    if (cachedRender) return { ...cachedRender, cached: true };

    const { root, entryCount } = buildTree(scan.entries, excludes);
    const keyFiles = collectKeyFiles(root);
    const header = [...(keyFiles.length > 0 ? [`Key files: ${keyFiles.join(", ")}`] : []), ...renderSymbolLines(symbolFiles)];
    const rendered = renderWithinBudget(root, header, {
      budget,
      maxDepth,
      entryCount,
      scanTruncated: scan.scanTruncated,
    });
    const result: RepoMapResult = { ...rendered, cached: false, entryCount };
    scan.renders.set(renderKey, result);
    return result;
  }

  /**
   * 轻量缓存（§4.1 预算段）：以根目录 mtime 为失效信号，mtime 未变且 TTL 内不重扫。
   * fs.scan 不返回逐文件 mtime，深层改动依赖 TTL（30s）兜底；这是有意的轻量取舍。
   */
  private async scan(sessionId: string, cwd: string): Promise<ScanCacheEntry> {
    const now = Date.now();
    const cached = this.scans.get(sessionId);
    let rootModifiedMs = 0;
    try {
      rootModifiedMs = (await this.core.statFile({ sessionId, path: cwd })).modifiedMs;
    } catch {
      // stat 失败不阻断：按"已变化"处理，直接重扫
    }
    if (cached && cached.rootModifiedMs === rootModifiedMs && now - cached.scannedAt < CACHE_TTL_MS) {
      return cached;
    }
    const entries: RepoMapEntry[] = [];
    let scanTruncated = false;
    let cursor: number | undefined;
    do {
      const page = await this.core.scanFiles({
        sessionId,
        path: cwd,
        limit: SCAN_PAGE_LIMIT,
        maxDepth: DEFAULT_MAX_DEPTH + 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of page.entries) {
        entries.push({ path: entry.path, type: entry.type, size: entry.size });
        if (entries.length >= SCAN_NODE_CAP) { scanTruncated = true; break; }
      }
      if (scanTruncated) break;
      scanTruncated = scanTruncated || page.truncated;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const entry: ScanCacheEntry = { rootModifiedMs, scannedAt: now, entries, scanTruncated, renders: new Map() };
    this.scans.set(sessionId, entry);
    return entry;
  }
}

/** 把扫描结果组装为目录树；被排除的目录连同其子树整体剔除。 */
function buildTree(entries: readonly RepoMapEntry[], excludes: readonly string[]): { root: DirNode; entryCount: number } {
  const root: DirNode = { dirs: new Map(), files: [] };
  const nodes = new Map<string, DirNode>([["", root]]);
  const excludedDirs = new Set<string>();
  let entryCount = 0;
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const normalized = entry.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized) continue;
    // 祖先目录被排除则整支跳过
    if ([...excludedDirs].some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))) continue;
    if (isPathExcluded(normalized, excludes)) {
      if (entry.type === "directory") excludedDirs.add(normalized);
      continue;
    }
    const segments = normalized.split("/");
    const name = segments.at(-1)!;
    const parentPath = segments.slice(0, -1).join("/");
    const parent = nodes.get(parentPath) ?? root;
    if (entry.type === "directory") {
      const node: DirNode = { dirs: new Map(), files: [] };
      parent.dirs.set(name, node);
      nodes.set(normalized, node);
    } else if (entry.type === "file") {
      parent.files.push(name);
    }
    // type === "other"（socket/设备节点等）不计入树
    entryCount += 1;
  }
  return { root, entryCount };
}

function collectKeyFiles(root: DirNode): string[] {
  return root.files
    .filter((name) => KEY_FILE_EXACT.has(name.toLowerCase()) || KEY_FILE_PATTERN.test(name))
    .slice(0, KEY_FILE_CAP);
}

/** 索引符号摘要行：最近修改优先，每行列出顶层符号名（截断如实标注）。 */
function renderSymbolLines(symbolFiles: readonly RepoMapSymbolFile[] | undefined): string[] {
  if (!symbolFiles || symbolFiles.length === 0) return [];
  const sorted = [...symbolFiles].sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path));
  const lines: string[] = [];
  for (const file of sorted.slice(0, SYMBOL_FILE_CAP)) {
    const names = file.symbols.slice(0, SYMBOL_NAMES_CAP).map((symbol) => symbol.name);
    const more = file.symbols.length > names.length ? `, … (+${file.symbols.length - names.length})` : "";
    if (names.length > 0) lines.push(`${file.path}: ${names.join(", ")}${more}`);
  }
  if (lines.length === 0) return [];
  const extra = symbolFiles.length > SYMBOL_FILE_CAP ? ` (+${symbolFiles.length - SYMBOL_FILE_CAP} more files)` : "";
  return [`Key files with symbols (recent first)${extra}:`, ...lines];
}

interface RenderBudget {
  budget: number;
  maxDepth: number;
  entryCount: number;
  scanTruncated: boolean;
}

/** 预算收缩策略：先逐级降深度，再折叠每层条目，最后硬截断；任何裁剪都如实标注。 */
function renderWithinBudget(root: DirNode, header: string[], options: RenderBudget): Omit<RepoMapResult, "cached" | "entryCount"> {
  for (let depth = options.maxDepth; depth >= 1; depth -= 1) {
    const lines = renderTree(root, depth, Number.POSITIVE_INFINITY);
    const candidate = compose(header, lines, truncationNote(depth < options.maxDepth || options.scanTruncated, options));
    if (estimateTokens(candidate) <= options.budget) {
      return { text: candidate, tokens: estimateTokens(candidate), truncated: depth < options.maxDepth || options.scanTruncated };
    }
  }
  for (const cap of [40, 20, 10, 5]) {
    const lines = renderTree(root, 2, cap);
    const candidate = compose(header, lines, truncationNote(true, options));
    if (estimateTokens(candidate) <= options.budget) {
      return { text: candidate, tokens: estimateTokens(candidate), truncated: true };
    }
  }
  // 最小形态也放不下的极端小预算：硬截断并标注（预算下限 64 tokens，通常不会走到这）。
  const note = truncationNote(true, options);
  const lines = compose(header, renderTree(root, 2, 5), note).split("\n");
  const kept: string[] = [];
  let tokens = estimateTokens(note);
  for (const line of lines.slice(0, -1)) {
    const cost = estimateTokens(line);
    if (tokens + cost > options.budget) break;
    kept.push(line);
    tokens += cost;
  }
  const text = [...kept, note].join("\n");
  return { text, tokens: estimateTokens(text), truncated: true };
}

function truncationNote(truncated: boolean, options: RenderBudget): string {
  if (!truncated) return "";
  const reasons = [options.scanTruncated ? `scan capped at ${SCAN_NODE_CAP} nodes` : ""].filter(Boolean).join("; ");
  return `[repo map truncated to fit ~${options.budget} token budget${reasons ? `; ${reasons}` : ""}; ${options.entryCount} entries after excludes]`;
}

function compose(header: string[], tree: string[], note: string): string {
  return [...header, ...tree, ...(note ? [note] : [])].join("\n");
}

/** 渲染目录树：每层先目录后文件，超出 perDirCap 折叠为 "… (+N more)"。 */
function renderTree(root: DirNode, maxDepth: number, perDirCap: number): string[] {
  const lines: string[] = [];
  const walk = (node: DirNode, depth: number): void => {
    if (depth > maxDepth) return;
    const indent = "  ".repeat(depth - 1);
    const dirs = [...node.dirs.keys()].sort();
    const files = [...node.files].sort();
    const total = dirs.length + files.length;
    let shown = 0;
    for (const name of dirs) {
      if (shown >= perDirCap) break;
      lines.push(`${indent}${name}/`);
      shown += 1;
      walk(node.dirs.get(name)!, depth + 1);
    }
    for (const name of files) {
      if (shown >= perDirCap) break;
      lines.push(`${indent}${name}`);
      shown += 1;
    }
    if (total > shown) lines.push(`${indent}… (+${total - shown} more)`);
  };
  walk(root, 1);
  return lines;
}
