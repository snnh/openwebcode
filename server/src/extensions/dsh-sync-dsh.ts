/**
 * dsh-sync 扩展 M1a：dsh（DeepSeek Harness）数据发现层纯函数模块。
 *
 * 只做四件事：路径归一、会话扫描/解码、附件内容寻址读写（M4a）、profile patch 的读与「CST 级保注释改写」；
 * 不依赖 Extension Host 与 server 其它模块，因此可独立单测。本模块不做任何自动同步、
 * 不负责备份时机（`replaceDshProviders` 不改盘，写盘与备份由调用方决定）。
 *
 * 上游权威参考（`.tmp/dsh-refs/session_session-persistence-jsonl/src/`，语义逐字移植）：
 * - `format.ts` 的 `encodeSegment` / `projectKey` / `projectDir` / `sessionDir` → {@link dshEncodeSegment}
 *   / {@link dshProjectKey} / {@link dshSessionDir}；
 * - `zstd.ts` 的 `scanZstdFrames`（帧边界结构扫描）→ 本模块内部同名函数；
 * - `zstd-public-decoder.ts` 的逐帧 `zstdDecompressSync` 校验 → {@link decodeDshSessionFile}。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readFile, readdir, copyFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { isMap, isSeq, parseDocument, stringify as yamlStringify, type Document } from "yaml";

/** dsh-sync 配置（M1a 只用到数据目录与 profile 两项）。 */
export interface DshSyncConfig {
  /** dsh 数据目录；缺省 {@link DSH_SYNC_DEFAULT_DSH_HOME}（`~` 前缀会展开）。 */
  dshHome?: string;
  /** profile 名；缺省 {@link DSH_SYNC_DEFAULT_PROFILE}。 */
  profile?: string;
}

/** 默认 dsh 数据目录（`~` 经 {@link resolveDshHome} 展开为 os.homedir()）。 */
export const DSH_SYNC_DEFAULT_DSH_HOME = "~/.dsh";

/** 默认 profile 名（与 openwebcode 侧 web 会话对齐）。 */
export const DSH_SYNC_DEFAULT_PROFILE = "web";

/**
 * 写出（导出）会话文件所用代际：owc → dsh 仍写 v3。
 * dsh 打开旧代际文件时按迁移链自动升级到当前代际，因此写 v3 是稳妥的「最大兼容」选择。
 */
export const DSH_SYNC_WRITE_GENERATION = 3;

/**
 * 读（导入/扫描）支持的会话格式代际：v3（dsh 旧代际）与 v4（dsh 当前代际）。
 * 比读支持更低的代际不能直接解（内容形态/校验规则不同），需先在 dsh 里打开一次升级；
 * 更高的代际含义未知，明确拒绝（由 dsh 负责迁移链，owc 只保证已核对过的形态）。
 */
export const DSH_SYNC_READ_GENERATIONS: readonly number[] = [3, 4];

/**
 * 该代际是否在「读」支持范围内（{@link DSH_SYNC_READ_GENERATIONS}）。
 * @param generation - 会话文件代际（0=v0 无 v 段 … 4=v4）。
 * @returns 支持读即 true。
 */
export function isSupportedReadGeneration(generation: number): boolean {
  return DSH_SYNC_READ_GENERATIONS.includes(generation);
}

/** 默认 dsh HTTP 端口（{@link probeDshRunning} 的缺省探测目标）。 */
const DSH_SYNC_DEFAULT_PORT = 3080;

/** patch.yml 中承载模型服务商配置的条目 id。 */
const LLM_ENTRY_ID = "llm-service-lite";

/** patch.yml 相对 profile 目录的文件名。 */
const PATCH_FILE_NAME = "cordis.patch.yml";

/** profile 目录名（patch.yml 固定落在 `<dshHome>/profiles/<profile>/` 下）。 */
const PROFILES_DIR_NAME = "profiles";

/** 会话目录内的规范文件名（无 v 段 = v0）。 */
const GENERATION_FILE_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/** 会话根目录相对 dshHome 的子目录名。 */
const SESSIONS_DIR_NAME = "sessions";

/** 附件内容寻址对象目录（相对 dshHome）。 */
const ATTACHMENT_OBJECTS_DIR = path.join("attachments", "v1", "objects");

/** 附件写入临时目录（相对 dshHome）；先落 tmp 再 rename，保证读到的是完整对象。 */
const ATTACHMENT_TMP_DIR = path.join("attachments", "v1", "tmp");

/**
 * attachmentId 形态：文件内容的 sha256 十六进制（68 字节前 2 位做分片目录）。
 * 严格限制为 64 位小写十六进制，任何其它输入（含 `../etc`）都拒绝，杜绝路径注入。
 */
const ATTACHMENT_ID_RE = /^[0-9a-f]{64}$/;

/** zstd 帧魔数（小端读取 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xFD2FB528;

/** 单次探测读取的头部窗口（头帧远小于此值；超出时回退整文件）。 */
const HEADER_PROBE_BYTES = 256 * 1024;

/**
 * 展开 `~` / `~/` 前缀为 os.homedir()；其它形式原样返回（不做用户级 `~user` 展开）。
 * @param raw - 原始路径文本。
 * @returns 展开后的路径文本（未 resolve）。
 */
function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(homedir(), raw.slice(2));
  return raw;
}

/**
 * 解析 dsh 数据目录为绝对路径。
 * @param config - 可选配置（`dshHome` 缺省 `~/.dsh`）。
 * @returns 绝对路径（`~` 展开 + `path.resolve`）。
 */
export function resolveDshHome(config?: DshSyncConfig): string {
  const raw = config?.dshHome !== undefined && config.dshHome.length > 0
    ? config.dshHome
    : DSH_SYNC_DEFAULT_DSH_HOME;
  return path.resolve(expandHome(raw));
}

/**
 * profile 名白名单：1–64 位的字母/数字/`.`/`_`/`-`。
 *
 * 配置来自扩展设置与面板输入（用户可写任意字符串），而 profile 会被拼进路径
 * （`<dshHome>/profiles/<profile>/cordis.patch.yml`）：限定字符集 + 长度即可排除
 * 路径分隔符、`..`、绝对路径、通配符等一切逃逸形态。
 */
const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 解析 profile 名（白名单校验，非法值**静默回落**默认 profile）。
 *
 * 回落而不抛错：profile 只决定「读哪个 patch.yml」，非法值最合理的处理是按默认 profile 继续
 * （状态面板仍可用、用户能在设置里改回来）；抛错会让 /status 与预览整页失败，反而更难自愈。
 * 非法值不额外告警：这是纯函数（无告警通道），且 {@link dshPatchFile} 另有 containment 断言兜底。
 * `.` / `..` 即使匹配白名单字符集也拒绝（路径穿越形态）。
 * @param config - 可选配置（`profile` 缺省 "web"，空串/非法值同样回落到缺省）。
 * @returns 合法 profile 名（恒满足 {@link PROFILE_RE}）。
 */
export function resolveDshProfile(config?: DshSyncConfig): string {
  const raw = config?.profile;
  if (raw === undefined || raw.length === 0) return DSH_SYNC_DEFAULT_PROFILE;
  if (raw === "." || raw === ".." || !PROFILE_RE.test(raw)) return DSH_SYNC_DEFAULT_PROFILE;
  return raw;
}

/**
 * 探测 node:zlib 的 zstd 能力。最低支持版本（Node 24.22.1）必然提供 zstd，
 * 这里保留运行时探测只为在异常精简的运行时上给出明确降级原因，不再作为版本门槛。
 * @returns 存在 `zstdDecompressSync` 即 true。
 */
export function zstdAvailable(): boolean {
  return typeof zlib.zstdDecompressSync === "function";
}

/**
 * TCP 探测 dsh 是否在监听（连通即 true）。
 * @param port - 目标端口，缺省 3080。
 * @param host - 目标地址，缺省 127.0.0.1。
 * @returns 750ms 内连接成功 true；拒绝/超时/出错 false。
 */
export function probeDshRunning(port: number = DSH_SYNC_DEFAULT_PORT, host = "127.0.0.1"): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * patch.yml 的绝对路径（不保证存在）。
 *
 * containment 断言：解析结果必须落在 `<dshHome>/profiles` 之内，否则抛错。profile 经
 * {@link resolveDshProfile} 白名单化后不可能逃逸，这里是对「别的调用方直接传 profile」的兜底
 * （路径拼接 + `..` 是典型的越权写入口，宁可在拼路径时炸掉，也不去写 patch.yml 目录外的文件）。
 * @param dshHome - dsh 数据目录绝对路径。
 * @param profile - profile 名。
 * @returns `<dshHome>/profiles/<profile>/cordis.patch.yml`。
 * @throws {Error} profile 解析后逃出 `<dshHome>/profiles` 时（路径穿越）。
 */
export function dshPatchFile(dshHome: string, profile: string): string {
  const profilesDir = path.resolve(dshHome, PROFILES_DIR_NAME);
  const file = path.resolve(profilesDir, profile, PATCH_FILE_NAME);
  const relative = path.relative(profilesDir, file);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`dsh profile 非法（解析后逃出 ${profilesDir}）：${profile}`);
  }
  return file;
}

/**
 * `!!js` 自定义标签：dsh 的 patch 里用 `!!js <表达式>` 透传宿主表达式，本模块按字符串保留，
 * 只要求「解析不抛错、改写不丢标签」。`identify` 必须存在，否则解析器会对未知标签告警且值不落地；
 * 因为它对所有值都返回 true，绝不能拿带此标签的 schema 去 stringify——本模块改写走原文拼接，
 * 只用 `yamlStringify` 渲染全新的 providers 字典（默认 schema）。
 */
const JS_EXPRESSION_TAG = {
  tag: "!!js",
  identify: (): boolean => true,
  resolve: (value: string): string => value,
};

/** 以容错 schema 解析 patch.yml（`!!js` 等自定义标签透传字符串，不抛错）。 */
function parsePatchDocument(text: string): Document {
  return parseDocument(text, { customTags: [JS_EXPRESSION_TAG] });
}

/** patch.yml 的根条目节点数组（根为序列，或根为映射且含 `items` 序列）。 */
function patchItems(doc: Document): readonly unknown[] {
  const root = doc.contents;
  if (isSeq(root)) return root.items;
  if (isMap(root)) {
    const items = root.get("items");
    return isSeq(items) ? items.items : [];
  }
  return [];
}

/** 某条目节点是否为映射且 `id === llm-service-lite`（YAMLMap.get 默认返回解包后的值）。 */
function isLlmEntry(item: unknown): boolean {
  return isMap(item) && item.get("id") === LLM_ENTRY_ID;
}

/** 定位 items[] 中 llm-service-lite 条目的下标（不存在返回 undefined）。 */
function findLlmEntryIndex(doc: Document): number | undefined {
  const items = patchItems(doc);
  for (let i = 0; i < items.length; i++) {
    if (isLlmEntry(items[i])) return i;
  }
  return undefined;
}

/** patch.yml 里的原始 yaml 节点（只取本模块需要的字段：文本区间与解包）。 */
interface PatchNode {
  /** 节点在原文中的 [起点, 终点, 节点末尾]，用于 CST 级拼接。 */
  range?: [number, number, number];
  /** 是否 flow 风格（`{...}` / `[...]`），无法安全插入块状子键。 */
  flow?: boolean;
  /** 映射的子项（Pair 列表）。 */
  items?: Array<{ key?: PatchNode }>;
  /** 解包为普通 JS 值（需要所属文档）。 */
  toJS?: (doc: Document) => unknown;
}

/** 取条目的 config.providers 节点（保留原始节点以获得 range / toJS）。 */
function providersNode(doc: Document, index: number): PatchNode | undefined {
  return doc.getIn([index, "config", "providers"], true) as PatchNode | undefined;
}

/** 取条目的 config.providers 解包后的值（路径不存在返回 undefined）。 */
function providersValue(doc: Document, index: number): unknown {
  const node = providersNode(doc, index);
  if (node === undefined) return undefined;
  return typeof node.toJS === "function" ? node.toJS(doc) : node;
}

/** 从节点值取纯对象形式的 provider 字典（非对象返回 undefined）。 */
function asProviders(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 读取 patch.yml 中 llm-service-lite 条目的 `config.providers`。
 * 文件不存在、YAML 含 `!!js` 等自定义标签、条目/字段缺失都返回 undefined（不抛错）。
 * @param patchFile - patch.yml 绝对路径。
 * @returns provider 名 → 配置的字典，或 undefined。
 */
export async function readDshProviders(patchFile: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(patchFile, "utf8");
  } catch {
    return undefined;
  }
  try {
    const doc = parsePatchDocument(text);
    const index = findLlmEntryIndex(doc);
    if (index === undefined) return undefined;
    return asProviders(providersValue(doc, index));
  } catch {
    return undefined;
  }
}

/** 把 provider 字典渲染为块状 YAML（缩进 2 空格，去除尾换行）。 */
function renderProvidersBlock(next: Record<string, unknown>, indent: number): string {
  const body = yamlStringify(next, { indent: 2 }).replace(/\n+$/, "");
  const pad = " ".repeat(indent);
  return body.split("\n").map((line, i) => (i === 0 ? line : pad + line)).join("\n");
}

/** 文档末尾追加 llm-service-lite 条目（原文本原样保留）。 */
function appendLlmEntry(patchText: string, next: Record<string, unknown>): string {
  const base = patchText.length === 0 || patchText.endsWith("\n") ? patchText : `${patchText}\n`;
  // 追加条目：`- id` 在 0 缩进，config 2，providers 4，字典内容 6。
  return `${base}- id: ${LLM_ENTRY_ID}\n  config:\n    providers:\n      ${renderProvidersBlock(next, 6)}\n`;
}

/**
 * CST 级改写：把 llm-service-lite 条目的 providers 字典整体替换为 `next`。
 *
 * 实现取「值节点 range 拼接」而非重新序列化整个文档，因此文档其余部分（注释、
 * `!!js` 标签、其它条目）逐字不变。条目不存在时在文档末尾追加该条目。
 *
 * 拼接时的边界处理（`range` 实测语义见 {@link replaceDshProviders} 内部注释）：
 * 起点不在行首（`providers: {...}` 同行 flow 值 / 空值）时先补换行与子级缩进；
 * 区间吃掉了本级行尾换行或后随内容与块粘行时补回换行，保证不留 `models: []#注释`
 * 这类非法 YAML。
 *
 * 本函数不管备份：调用方负责先 {@link backupFile}。
 * @param patchText - 原 patch.yml 文本。
 * @param next - 新的 providers 字典。
 * @returns 改写后的新文本。
 */
export function replaceDshProviders(patchText: string, next: Record<string, unknown>): string {
  let doc: Document;
  try {
    doc = parsePatchDocument(patchText);
  } catch {
    return appendLlmEntry(patchText, next);
  }
  const index = findLlmEntryIndex(doc);
  if (index === undefined) return appendLlmEntry(patchText, next);

  const node = providersNode(doc, index);
  const range = node?.range;
  if (range === undefined) {
    // 条目在但没有 providers 节点：插入到该条目 config 块末尾（flow 风格无法安全插入 → 退回追加）。
    const inserted = insertProvidersIntoEntry(patchText, doc, index, next);
    return inserted ?? appendLlmEntry(patchText, next);
  }

  // range 实测语义（yaml 包）：`[start, end, nodeEnd]`，start/end 都从「值内容」起算，
  // 不含本行前导缩进；块状值时 end 已吃掉本级行尾换行（`#注释` 紧随其后时
  // charAt(end) 就是 `#`），flow 值时 end 停在 `}` 上、nodeEnd 才含行尾与行内注释。
  const [start, end] = range;
  const lineHead = patchText.slice(patchText.lastIndexOf("\n", start - 1) + 1, start);
  // 起点已在行首（前面只剩缩进）：缩进仍在原文里，直接复用它做块内续行缩进。
  const ownLine = lineHead.trim().length === 0;
  // 起点与 `providers:` 同行（flow 值、空值、或紧跟同行注释）：必须换行并把块缩进到子级。
  const indent = ownLine ? lineHead.length : lineHead.length - lineHead.trimStart().length + 2;
  const block = renderProvidersBlock(next, indent);
  const head = ownLine ? "" : `\n${" ".repeat(indent)}`;
  // 块尾换行：区间吃掉本级行尾换行时补回（否则会吞掉紧随其后的空行），
  // 后随内容仍与本行同行（flow 值后的行内注释）时也必须补一个，避免新块与后续 token 粘连。
  const consumedNewline = end > start && patchText.charAt(end - 1) === "\n";
  const nextChar = patchText.charAt(end);
  const tail = consumedNewline || (nextChar !== "" && nextChar !== "\n") ? `${block}\n` : block;
  return patchText.slice(0, start) + head + tail + patchText.slice(end);
}

/** 向已存在条目的 config 块末尾补 `providers:`（flow 风格或结构不符返回 undefined）。 */
function insertProvidersIntoEntry(
  patchText: string,
  doc: Document,
  index: number,
  next: Record<string, unknown>,
): string | undefined {
  const config = doc.getIn([index, "config"], true) as PatchNode | undefined;
  const range = config?.range;
  const items = config?.items;
  if (range === undefined || config?.flow === true || !Array.isArray(items)) return undefined;
  const keyRange = items[0]?.key?.range;
  if (keyRange === undefined) return undefined;
  const indent = keyRange[0] - (patchText.lastIndexOf("\n", keyRange[0] - 1) + 1);
  const pad = " ".repeat(indent);
  // 节点 range 可能已吃掉本级行尾换行，此时不再补一个（否则会多出空行）。
  const head = patchText.charAt(range[1] - 1) === "\n" ? "" : "\n";
  const insertion = `${head}${pad}providers:\n${" ".repeat(indent + 2)}${renderProvidersBlock(next, indent + 2)}`;
  return patchText.slice(0, range[1]) + insertion + patchText.slice(range[1]);
}

/**
 * 备份：复制为 `<file>.owc-sync-backup-<ISO 时间戳>`（冒号换 `-`，Windows 友好）。
 * @param file - 待备份文件。
 * @returns 备份文件路径。
 */
export async function backupFile(file: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const target = `${file}.owc-sync-backup-${stamp}`;
  await copyFile(file, target);
  return target;
}

/**
 * 把任意字符串编码为单个安全路径段（上游 `format.ts` 的 `encodeSegment` 逐字移植）：
 * 安全码元字面保留，其余（含 `~` 自身）转义为 `~XXXX`；`.`/`..` 特判防目录穿越。
 * @param raw - 待编码字符串，非空。
 * @returns 可逆的单段路径名。
 */
export function dshEncodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return out;
}

/** `~XXXX` 转义段还原（非法转义返回 undefined，调用方回落目录名原样）。 */
function decodeSegment(raw: string): string | undefined {
  if (raw === "~002E") return ".";
  if (raw === "~002E~002E") return "..";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch !== "~") {
      out += ch;
      continue;
    }
    const hex = raw.slice(i + 1, i + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return undefined;
    out += String.fromCharCode(parseInt(hex, 16));
    i += 4;
  }
  return out;
}

/**
 * 项目目录键（上游 `format.ts` 的 `projectKey`，含 251 字符截断语义）：
 * 路径分隔符折叠为 `-`，不安全码元用 `~XXXX`；`undefined` → `_no-cwd`。
 * @param cwd - 会话工作目录；undefined 表示无 cwd。
 * @returns `--<slug>--` 形式的项目目录名。
 */
export function dshProjectKey(cwd: string | undefined): string {
  if (cwd === undefined) return "_no-cwd";
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

/**
 * 会话目录绝对路径（上游 `sessionDir` + `projectDir` 语义）。
 * @param dshHome - dsh 数据目录绝对路径。
 * @param cwd - 会话工作目录（undefined → `_no-cwd`）。
 * @param id - 会话 id（编码为单段路径）。
 * @returns `<dshHome>/sessions/<projectKey>/<encodeSegment(id)>`。
 */
export function dshSessionDir(dshHome: string, cwd: string | undefined, id: string): string {
  return path.join(dshHome, SESSIONS_DIR_NAME, dshProjectKey(cwd), dshEncodeSegment(id));
}

/**
 * 附件的对象文件绝对路径。
 * 存储布局（已用真实 `~/.dsh/attachments` 验证）：`<dshHome>/attachments/v1/objects/<sha256 前 2 位>/<完整 sha256 hex>`。
 * @param dshHome - dsh 数据目录绝对路径。
 * @param attachmentId - 附件 id（64 位小写十六进制 sha256）。
 * @returns 绝对路径；id 形态非法（含路径穿越）时 undefined。
 */
export function dshAttachmentObjectPath(dshHome: string, attachmentId: string): string | undefined {
  if (!ATTACHMENT_ID_RE.test(attachmentId)) return undefined;
  return path.join(dshHome, ATTACHMENT_OBJECTS_DIR, attachmentId.slice(0, 2), attachmentId);
}

/**
 * 同步读取附件字节（host 侧图片是小文件，避免为读图引入异步复杂度）。
 * @param dshHome - dsh 数据目录绝对路径。
 * @param attachmentId - 附件 id。
 * @returns 文件字节；id 非法或文件不存在/不可读时 undefined。
 */
export function readDshAttachment(dshHome: string, attachmentId: string): Buffer | undefined {
  const file = dshAttachmentObjectPath(dshHome, attachmentId);
  if (file === undefined) return undefined;
  try {
    return readFileSync(file);
  } catch {
    return undefined;
  }
}

/** 清理临时文件（失败不影响主流程：tmp 目录本身是可丢弃的）。 */
function removeQuietly(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // 清理失败无副作用（tmp 目录允许残留）
  }
}

/**
 * 内容寻址写入附件（attachmentId = sha256(字节)）；已存在同内容对象时直接复用（幂等）。
 *
 * 原子性：先写 `<dshHome>/attachments/v1/tmp/<id>.<uuid>.tmp`，再 `rename` 到对象路径——
 * 同目录内 rename 是原子操作，dsh 侧不会读到半个文件。
 * @param dshHome - dsh 数据目录绝对路径。
 * @param bytes - 附件字节。
 * @returns 该内容的 attachmentId（sha256 hex）。
 */
export function writeDshAttachment(dshHome: string, bytes: Buffer): string {
  const attachmentId = createHash("sha256").update(bytes).digest("hex");
  const target = dshAttachmentObjectPath(dshHome, attachmentId);
  // id 由本函数自己算出，必为合法形态；这里只是让类型收窄（不满足时按编程错误抛出）。
  if (target === undefined) throw new Error(`内部错误：附件 id 形态非法 ${attachmentId}`);
  if (existsSync(target)) return attachmentId;

  const tmpDir = path.join(dshHome, ATTACHMENT_TMP_DIR);
  const tmpFile = path.join(tmpDir, `${attachmentId}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, bytes);
    mkdirSync(path.dirname(target), { recursive: true });
    try {
      renameSync(tmpFile, target);
    } catch (error: unknown) {
      // 并发写同一附件：另一写入者可能已把对象落地，此时等价于成功（只清掉自己的 tmp）。
      if (!existsSync(target)) throw error;
      removeQuietly(tmpFile);
    }
  } catch (error: unknown) {
    removeQuietly(tmpFile);
    throw error;
  }
  return attachmentId;
}

/** zstd 帧字节区间（上游 `zstd.ts` 的 `ZstdFrameRange`）。 */
interface ZstdFrameRange {
  /** 帧起始（含）。 */
  start: number;
  /** 帧结束（不含）。 */
  end: number;
}

/** zstd 拼接流的结构扫描结果（上游 `ZstdFrameScan`）。 */
interface ZstdFrameScan {
  /** 按文件顺序的完整帧。 */
  frames: ZstdFrameRange[];
  /** EOF 截断的尾帧起点（存在时表示文件尾部正在写入）。 */
  tornStart?: number;
}

/**
 * 不解压、只按帧头/块头结构定位完整帧（上游 `scanZstdFrames` 逐字移植）。
 * 结构非法直接抛错；EOF 落在最后一帧内则返回其起点供修复。
 * @param buffer - 会话文件当前完整的字节。
 * @returns 完整帧区间与可能的截断尾帧起点。
 */
function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return { frames };
}

/**
 * 逐帧解压并拼接 zstd 容器（帧带 checksum，`zstdDecompressSync` 会逐帧校验）。
 * 写入中的截断尾帧被忽略（读到的完整帧仍有意义）。
 * @param buffer - 会话文件全部字节。
 * @param file - 出错信息里报告的文件路径。
 * @returns 拼接后的 plaintext。
 */
function decodeZstdContainer(buffer: Buffer, file: string): Buffer {
  const { frames } = scanZstdFrames(buffer);
  if (frames.length === 0) {
    throw new Error(`会话文件格式损坏：${file} 中没有完整的 zstd 帧`);
  }
  const parts: Buffer[] = [];
  for (const { start, end } of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
    } catch (error: unknown) {
      throw new Error(`会话文件格式损坏：${file} 第 ${start} 字节处的 zstd 帧校验失败`, { cause: error });
    }
  }
  return Buffer.concat(parts);
}

/** 会话文件中的一行 JSON 对象（事件行信封与头行共用）。 */
type SessionLine = Record<string, unknown>;

/** 会话目录扫描结果（一个会话目录一条）。 */
export interface DshSessionEntry {
  /** 目录名解码后的会话 id（不可解码时用目录名原样）。 */
  sessionId: string;
  /** 头行 cwd（头不可读时 undefined）。 */
  cwd?: string;
  /** 会话目录绝对路径。 */
  dir: string;
  /** 选中的最高代际文件绝对路径；无任何规范文件时 undefined。 */
  file?: string;
  /** 0=v0(session.jsonl) … 3=v3、4=v4（dsh 当前代际）。 */
  generation?: number;
  /** 是否为 zstd 容器（`.jsonl.zstd`）。 */
  compressed?: boolean;
  /** 头行 JSON（读支持的代际才解析；更低/更高代际不解析）。 */
  header?: SessionLine;
  /** 头行 origin（如 subagent）。 */
  origin?: string;
  /** 头行 parentSession（子代理会话指回主会话）。 */
  parentSession?: string;
  /** 扫描/解析错误（损坏文件等）；有值时其它字段可能不完整。 */
  error?: string;
}

/** 从目录项里选出的规范会话文件。 */
interface PickedFile {
  /** 绝对路径。 */
  file: string;
  /** 代际（无 v 段 = 0）。 */
  generation: number;
  /** 是否 zstd 容器。 */
  compressed: boolean;
}

/** 在目录项中选数值最高代际的规范文件（同代际优先 zstd）；无规范文件返回 undefined。 */
function pickGenerationFile(dir: string, names: readonly string[]): PickedFile | undefined {
  let best: PickedFile | undefined;
  for (const name of names) {
    const matched = GENERATION_FILE_RE.exec(name);
    if (matched === null) continue;
    const generation = matched[1] === undefined ? 0 : Number(matched[1]);
    const compressed = matched[2] !== undefined;
    const better = best === undefined
      || generation > best.generation
      || (generation === best.generation && compressed && !best.compressed);
    if (better) best = { file: path.join(dir, name), generation, compressed };
  }
  return best;
}

/** 读取文件头部字节（最多 bytes）。 */
async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const size = Math.min(bytes, (await handle.stat()).size);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 从 zstd 容器里只解压第一帧（头帧）；探测窗口不足以容纳头帧时回退整文件。 */
async function decodeFirstFrame(file: string, head: Buffer): Promise<Buffer> {
  const { frames } = scanZstdFrames(head);
  const first = frames[0];
  if (first !== undefined) return zlib.zstdDecompressSync(head.subarray(first.start, first.end));
  const whole = await readFile(file);
  const all = scanZstdFrames(whole);
  const head0 = all.frames[0];
  if (head0 === undefined) throw new Error(`会话文件格式损坏：${file} 中没有完整的 zstd 帧`);
  return zlib.zstdDecompressSync(whole.subarray(head0.start, head0.end));
}

/** 解析头行（只读文件头，不整份解析；读支持的代际扫描用）。 */
async function readSessionHeader(file: string, compressed: boolean): Promise<SessionLine | undefined> {
  const head = await readHead(file, HEADER_PROBE_BYTES);
  const plain = compressed ? await decodeFirstFrame(file, head) : head;
  const newline = plain.indexOf(0x0A);
  const line = plain.subarray(0, newline === -1 ? plain.length : newline).toString("utf8").trim();
  if (line.length === 0) return undefined;
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as SessionLine;
}

/**
 * 扫描 `<dshHome>/sessions/**` 下所有会话目录，每目录选数值最高代际的规范文件。
 * 目录不存在返回 []；单个目录/文件出错不中断扫描，错误记入 `error`。
 * @param dshHome - dsh 数据目录绝对路径。
 * @returns 会话条目列表（按目录路径排序，稳定可复现）。
 */
export async function scanDshSessions(dshHome: string): Promise<DshSessionEntry[]> {
  const root = path.join(dshHome, SESSIONS_DIR_NAME);
  let projectEntries;
  try {
    projectEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries: DshSessionEntry[] = [];
  for (const project of projectEntries) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    const projectDir = path.join(root, project.name);
    let sessionEntries;
    try {
      sessionEntries = await readdir(projectDir, { withFileTypes: true });
    } catch (error: unknown) {
      entries.push({ sessionId: project.name, dir: projectDir, error: messageOf(error) });
      continue;
    }
    for (const session of sessionEntries) {
      if (!session.isDirectory() && !session.isSymbolicLink()) continue;
      entries.push(await scanSessionDir(projectDir, session.name));
    }
  }
  entries.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return entries;
}

/** 扫描单个会话目录：选规范文件、读支持的代际补头行；错误记入 `error`（不抛出）。 */
async function scanSessionDir(projectDir: string, sessionName: string): Promise<DshSessionEntry> {
  const dir = path.join(projectDir, sessionName);
  const entry: DshSessionEntry = { sessionId: decodeSegment(sessionName) ?? sessionName, dir };
  let files;
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    entry.error = messageOf(error);
    return entry;
  }
  const picked = pickGenerationFile(dir, files.filter((item) => item.isFile()).map((item) => item.name));
  if (picked === undefined) return entry;
  entry.file = picked.file;
  entry.generation = picked.generation;
  entry.compressed = picked.compressed;
  await fillHeader(entry, picked);
  return entry;
}

/** 读支持的代际才解析头行，并把 cwd / origin / parentSession 提到条目上（解析失败记 error）。 */
async function fillHeader(entry: DshSessionEntry, picked: PickedFile): Promise<void> {
  if (!isSupportedReadGeneration(picked.generation)) return;
  try {
    const header = await readSessionHeader(picked.file, picked.compressed);
    if (header === undefined) return;
    entry.header = header;
    if (typeof header.cwd === "string") entry.cwd = header.cwd;
    if (typeof header.origin === "string") entry.origin = header.origin;
    if (typeof header.parentSession === "string") entry.parentSession = header.parentSession;
  } catch (error: unknown) {
    entry.error = messageOf(error);
  }
}

/** 统一错误文本（非 Error 也给出可读形式）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解码选中的会话文件：zstd 逐帧解压拼接或 raw 直读，再按行 JSON.parse。
 *
 * 校验：头行 `type === "session"` 且 `version === generation`；事件 `seq` 从 0 稠密
 * （断档报「格式损坏」）。读支持 {@link DSH_SYNC_READ_GENERATIONS}（v3/v4）两代形态。
 * @param entry - 扫描结果中的选中文件信息。
 * @returns 头行对象与事件行数组。
 */
export async function decodeDshSessionFile(
  entry: { file: string; generation: number; compressed: boolean },
): Promise<{ header: SessionLine; events: SessionLine[] }> {
  if (!isSupportedReadGeneration(entry.generation)) {
    throw new Error(
      `不支持的代际：v${entry.generation}（会话文件 ${entry.file}，读支持 v${DSH_SYNC_READ_GENERATIONS.join("/v")}）`,
    );
  }
  const raw = await readFile(entry.file);
  const plain = entry.compressed ? decodeZstdContainer(raw, entry.file) : raw;
  const lines = plain.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) {
    throw new Error(`会话文件格式损坏：${entry.file} 为空或缺少头行`);
  }
  const header = parseLine(headerLine, entry.file, "头行");
  if (header.type !== "session" || header.version !== entry.generation) {
    throw new Error(`会话文件格式损坏：${entry.file} 头行不是 v${entry.generation} 会话头`);
  }

  const events: SessionLine[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const event = parseLine(line, entry.file, `第 ${i + 1} 行`);
    if (typeof event.type !== "string" || typeof event.seq !== "number") {
      throw new Error(`会话文件格式损坏：${entry.file} 第 ${i + 1} 行不是合法事件`);
    }
    if (event.seq !== i - 1) {
      throw new Error(`会话文件格式损坏：${entry.file} 第 ${i + 1} 行 seq=${event.seq}，期望 ${i - 1}（事件序列断档）`);
    }
    events.push(event);
  }
  return { header, events };
}

/** 单行 JSON 解析（失败归入「格式损坏」）。 */
function parseLine(line: string, file: string, where: string): SessionLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error: unknown) {
    throw new Error(`会话文件格式损坏：${file} ${where} 不是合法 JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`会话文件格式损坏：${file} ${where} 不是 JSON 对象`);
  }
  return parsed as SessionLine;
}
