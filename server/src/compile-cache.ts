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
 */
import { constants, enableCompileCache } from "node:module";
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
