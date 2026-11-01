/**
 * V8 编译缓存（Node 22.8+ 的 `module.enableCompileCache()`，Node 24 默认可用）。
 *
 * 服务端进程每次启动都要编译 dist 下上百个 ESM 模块（以及 fastify/undici/ws 等依赖），
 * 这部分 CPU 与峰值内存都落在冷启动上。开启编译缓存后 V8 把编译产物（字节码）按源码
 * 内容哈希写到数据目录，下次启动直接复用：CI/容器化部署的「重启即冷启」场景收益最明显，
 * 缓存随源码变化自动失效，不需要手动清理。
 *
 * 关键约束：**必须在入口文件的第一条 import 求值**。ESM 按 import 声明顺序深度优先求值，
 * 只要本模块是 `index.ts` / `cli.ts` 的第一个 import，后续模块的编译就能命中缓存。
 *
 * 目录选择：优先 `<dataDir>/cache/compile`（`OWC_DATA_DIR` 显式指定时；数据目录内的缓存
 * 随数据一起清理/迁移）；数据目录未知时用平台缓存目录（POSIX 的 `$XDG_CACHE_HOME` 或
 * `~/.cache`，Windows 的 `%LOCALAPPDATA%`）。**绝不落 /tmp**：编译缓存是跨重启复用的持久
 * 内容，临时目录会被清理/重启清空，放到 tmpfs 上还白占内存。HOME 也解析不到时直接关闭缓存。
 * 关闭方式：`OWC_COMPILE_CACHE=0`（也会被 Node 自带的 `NODE_DISABLE_COMPILE_CACHE=1` 覆盖）。
 *
 * 清理（`sweepCompileCache`）：字节码按源码哈希寻址，跨构建永远不会再命中，只会白占磁盘。
 * 启动时比对构建版本标记，版本变了整体清空；运行期每小时按「14 天未用 / 32MB 上限」再收一次，
 * 与项目其它常驻缓存的空闲清扫同一纪律。
 */
import { constants, enableCompileCache } from "node:module";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CompileCacheState {
  /** enabled / already-enabled / disabled / failed */
  status: string;
  directory?: string;
}

/** 数字状态码 → 可读名称（module.constants.compileCacheStatus）。 */
function statusName(status: number): string {
  if (status === constants.compileCacheStatus.ENABLED) return "enabled";
  if (status === constants.compileCacheStatus.ALREADY_ENABLED) return "already-enabled";
  if (status === constants.compileCacheStatus.DISABLED) return "disabled";
  return "failed";
}

/** 解析缓存目录；返回 undefined 表示没有可持久化的位置（此时不启用缓存）。 */
function cacheDirectory(): string | undefined {
  const configured = process.env.OWC_DATA_DIR?.trim();
  if (configured) {
    try {
      return path.join(path.resolve(configured), "cache", "compile");
    } catch {
      // 非法路径（例如含 NUL）：继续走平台缓存目录
    }
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "openwebcode", "compile-cache");
    const home = process.env.USERPROFILE?.trim() || os.homedir();
    return home ? path.join(home, "AppData", "Local", "openwebcode", "compile-cache") : undefined;
  }
  const xdgCache = process.env.XDG_CACHE_HOME?.trim();
  if (xdgCache) return path.join(xdgCache, "openwebcode", "compile-cache");
  const home = process.env.HOME?.trim() || os.homedir();
  return home ? path.join(home, ".cache", "openwebcode", "compile-cache") : undefined;
}

/**
 * 开启编译缓存；任何失败都静默降级（只影响启动速度，不影响功能）。
 * 返回状态供启动日志展示，便于用户确认缓存是否真的生效。
 */
function enableStartupCompileCache(): CompileCacheState {
  if (process.env.OWC_COMPILE_CACHE === "0") return { status: "disabled" };
  const directory = cacheDirectory();
  if (directory === undefined) return { status: "disabled" };
  try {
    const result = enableCompileCache(directory);
    const status = statusName(result.status);
    if (status === "failed" || status === "disabled") return { status };
    return { status, directory: result.directory ?? directory };
  } catch {
    return { status: "failed" };
  }
}

/** 缓存目录里记录「这批字节码属于哪个构建」的标记文件（Node 自身不会读它）。 */
const BUILD_MARKER = ".owc-build-version";
/** 缓存总量上限：单次构建实测约 3.2MB，32MB 约等于 10 次构建的余量。 */
const MAX_COMPILE_CACHE_BYTES = 32 * 1024 * 1024;
/** 条目最长闲置时间：超过即视为不会再命中的陈旧字节码。 */
const MAX_COMPILE_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Node 按 `v<ver>-<arch>-<hash>/` 分子目录存放字节码，遍历深度留一点余量。 */
const MAX_CACHE_DEPTH = 4;

export interface CompileCacheSweepOptions {
  /** 当前构建版本（服务器版本号）：与目录内标记不一致时整体清空。 */
  version?: string;
  /** 缓存目录；缺省用当前生效的编译缓存目录（测试可注入）。 */
  directory?: string;
  /** 字节上限，默认 32MB。 */
  maxBytes?: number;
  /** 闲置上限（毫秒），默认 14 天。 */
  maxAgeMs?: number;
  /** 当前时间（测试注入）。 */
  now?: number;
}

export interface CompileCacheSweepResult {
  /** 实际删除的文件数。 */
  removed: number;
  /** 释放的字节数。 */
  freedBytes: number;
  /** 是否因构建版本变化整体清空。 */
  cleared: boolean;
  /** 安全校验未通过而跳过（不做任何删除）。 */
  skipped: boolean;
}

const EMPTY_RESULT: CompileCacheSweepResult = { removed: 0, freedBytes: 0, cleared: false, skipped: false };

interface CacheFile {
  /** 相对缓存目录的路径（删除前再拼回绝对路径，避免误删目录外内容）。 */
  relative: string;
  size: number;
  mtimeMs: number;
}

/** child 是否严格位于 parent 内（不相等、不越界）。 */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * 安全校验：只清理「确实是 owc 自己创建的编译缓存目录」。
 *
 * 删除是不可逆操作，而缓存目录来自环境变量/数据目录配置，可能被指错（`OWC_DATA_DIR=/`
 * 会得到 `/cache/compile`）或被替换成指向别处的符号链接。因此逐条校验：
 * 1. 必须是绝对路径，且不是文件系统根；
 * 2. 自身必须是真实目录，**不能是符号链接**（lstat，不跟随）；
 * 3. 结尾必须是我们写入的两种布局之一：`cache/compile` 或 `openwebcode/compile-cache`；
 * 4. 不能是 HOME（兜底防手滑）。
 * 校验不过就完全不删，只记一条「跳过」。
 */
async function safeCacheDirectory(directory: string): Promise<string | undefined> {
  if (!path.isAbsolute(directory)) return undefined;
  const normalised = path.resolve(directory);
  if (normalised === path.parse(normalised).root) return undefined;
  const info = await lstat(normalised).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) return undefined;
  const tails = [path.join("cache", "compile"), path.join("openwebcode", "compile-cache")];
  if (!tails.some((tail) => normalised.endsWith(tail))) return undefined;
  if (normalised === os.homedir()) return undefined;
  return normalised;
}

/** 递归列出缓存文件：跳过符号链接、只收普通文件，并记录相对路径便于再次校验。 */
async function listCacheFiles(directory: string, depth = 0): Promise<CacheFile[]> {
  if (depth > MAX_CACHE_DEPTH) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return [];
  const files: CacheFile[] = [];
  for (const entry of entries) {
    if (entry.name === BUILD_MARKER) continue;
    const target = path.join(directory, entry.name);
    if (!isWithin(directory, target)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const nested = await listCacheFiles(target, depth + 1);
      for (const file of nested) files.push({ ...file, relative: path.join(entry.name, file.relative) });
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await lstat(target).catch(() => undefined);
    if (info?.isFile()) files.push({ relative: entry.name, size: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

/** 删除单个缓存文件；删除前重新校验它仍在目录内且不是符号链接。 */
async function removeCacheFile(directory: string, file: CacheFile): Promise<number> {
  const target = path.join(directory, file.relative);
  if (!isWithin(directory, target)) return 0;
  const info = await lstat(target).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) return 0;
  try {
    await rm(target, { force: true });
    return info.size;
  } catch {
    return 0;
  }
}

/** 清空目录内容（保留构建标记）：只删除目录内、非符号链接的条目。 */
async function clearCacheFiles(directory: string): Promise<{ removed: number; freedBytes: number }> {
  const files = await listCacheFiles(directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === BUILD_MARKER) continue;
    const target = path.join(directory, entry.name);
    if (!isWithin(directory, target) || entry.isSymbolicLink()) continue;
    try {
      await rm(target, { recursive: true, force: true });
    } catch {
      // 单个条目删不掉（被占用等）时继续删其余条目
    }
  }
  return { removed: files.length, freedBytes: files.reduce((sum, file) => sum + file.size, 0) };
}

/**
 * 清理编译缓存：构建版本变化 → 整体清空；否则先删闲置超龄条目，再按总量上限逐出最旧的。
 * 未启用缓存、目录不存在或安全校验不通过时为空操作。
 *
 * 安全前提：**只有目录里存在我们自己写的构建标记时才会删除**。首次清理（旧版本没有标记）
 * 只补写标记，绝不删任何文件——避免把配错目录里的用户数据当成缓存清掉。
 */
export async function sweepCompileCache(options: CompileCacheSweepOptions = {}): Promise<CompileCacheSweepResult> {
  const candidate = options.directory ?? compileCacheState.directory;
  if (candidate === undefined) return EMPTY_RESULT;
  const directory = await safeCacheDirectory(candidate);
  if (directory === undefined) return { ...EMPTY_RESULT, skipped: true };
  const markerPath = path.join(directory, BUILD_MARKER);
  const marker = await readFile(markerPath, "utf8").catch(() => undefined);

  // 1) 构建版本变化：旧字节码按源码哈希寻址，新构建不会再命中 → 整批丢弃。
  if (options.version !== undefined && marker !== undefined && marker.trim() !== options.version) {
    const { removed, freedBytes } = await clearCacheFiles(directory);
    await writeFile(markerPath, `${options.version}\n`, "utf8").catch(() => undefined);
    return { removed, freedBytes, cleared: true, skipped: false };
  }
  if (marker === undefined) {
    // 首次清理（没有标记）：只写标记，本轮不删任何东西
    const entries = await readdir(directory).catch(() => []);
    if (entries.length === 0) return EMPTY_RESULT;
    if (options.version !== undefined) await writeFile(markerPath, `${options.version}\n`, "utf8").catch(() => undefined);
    return EMPTY_RESULT;
  }

  // 2) 闲置超龄 → 总量上限（最旧优先）。
  const files = await listCacheFiles(directory);
  if (files.length === 0) return EMPTY_RESULT;
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? MAX_COMPILE_CACHE_AGE_MS;
  const maxBytes = options.maxBytes ?? MAX_COMPILE_CACHE_BYTES;
  let removed = 0;
  let freedBytes = 0;
  const survivors: CacheFile[] = [];
  for (const file of files) {
    if (now - file.mtimeMs > maxAgeMs) {
      const size = await removeCacheFile(directory, file);
      if (size > 0) { removed += 1; freedBytes += size; }
    } else {
      survivors.push(file);
    }
  }
  let total = survivors.reduce((sum, file) => sum + file.size, 0);
  if (total > maxBytes) {
    for (const file of [...survivors].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) break;
      const size = await removeCacheFile(directory, file);
      if (size > 0) { removed += 1; freedBytes += size; total -= size; }
    }
  }
  return { removed, freedBytes, cleared: false, skipped: false };
}

/**
 * 用户主动清理（设置 → 服务信息「清理缓存」）：清空缓存文件但保留构建标记。
 *
 * 与 `sweepCompileCache` 共用同一套安全校验，并且**只在目录里已有构建标记时才删除**——
 * 标记证明这个目录确实是本程序写入的编译缓存，避免把配错目录里的用户数据当成缓存清掉。
 */
export async function clearCompileCache(directory?: string): Promise<CompileCacheSweepResult> {
  const candidate = directory ?? compileCacheState.directory;
  if (candidate === undefined) return EMPTY_RESULT;
  const safe = await safeCacheDirectory(candidate);
  if (safe === undefined) return { ...EMPTY_RESULT, skipped: true };
  const marker = await readFile(path.join(safe, BUILD_MARKER), "utf8").catch(() => undefined);
  if (marker === undefined) return { ...EMPTY_RESULT, skipped: true };
  const { removed, freedBytes } = await clearCacheFiles(safe);
  return { removed, freedBytes, cleared: removed > 0, skipped: false };
}

/** 版本比较：current >= minimum（忽略 -rc/preview 等后缀）。 */
export function nodeVersionAtLeast(current: string, minimum: string): boolean {
  const parse = (value: string): number[] => value.split(/[+-]/)[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(current);
  const b = parse(minimum);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** 入口文件 import 时即生效（供启动日志读取结果）。 */
export const compileCacheState: CompileCacheState = enableStartupCompileCache();
