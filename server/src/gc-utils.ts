import v8 from "node:v8";
import vm from "node:vm";

/**
 * 进程内 full GC 的统一入口。
 *
 * 为什么需要运行时兜底：显式触发 full GC 依赖 Node 启动参数 `--expose-gc`（两个平台的 launcher
 * 都会注入 NODE_OPTIONS），但直接 `node server/dist/index.js` 启动（开发/手动部署）、旧版安装
 * 未升级启动脚本时该参数可能缺失——若只写 `global.gc?.()`，这些 GC 钩子会静默全部失效（可选
 * 调用链零成本跳过）。V8 允许运行时设置 flag：`v8.setFlagsFromString` 之后新建的 context
 * 会带上 `gc`（Node 14+ 可用的标准技巧），据此在首次调用时补出 gc 函数。
 *
 * 节流目的：full GC 会停下整个进程（几十到几百 ms），热机时若每个 tick/每个 run 结束都无脑
 * 触发，收益被暂停开销吃掉；因此提供最小间隔参数，让调用点可以「批量归还」而不是「随时归还」。
 */

/** 解析结果缓存：null 表示确认不可用（含探测失败），避免每次调用都重试 flag 注入。 */
let cachedGc: (() => void) | null | undefined;
/** 上次真正执行 full GC 的时间戳（毫秒）。用 -Infinity 使首次调用不受节流影响。 */
let lastGcAt = Number.NEGATIVE_INFINITY;

/**
 * 取到可用的 full GC 函数：优先用启动参数注入的 globalThis.gc；缺失时按需注入 V8 flag
 * 并从新 context 取 `gc`。只会解析一次；彻底失败返回 null（调用方零成本跳过）。
 */
export function resolveGc(): (() => void) | null {
  if (cachedGc !== undefined) return cachedGc;
  const existing = (globalThis as { gc?: () => void }).gc;
  if (typeof existing === "function") {
    // 包一层：避免直接引用 globalThis.gc 时被解绑 this（V8 的 gc 不依赖 this，但语义更干净）
    cachedGc = () => (globalThis as { gc?: () => void }).gc?.();
    return cachedGc;
  }
  cachedGc = exposeGcAtRuntime();
  return cachedGc;
}

/** 运行时注入 `--expose-gc` 并返回新 context 里的 gc；两种 flag 写法都试（Node 与 V8 命名差异）。 */
function exposeGcAtRuntime(): (() => void) | null {
  for (const flag of ["--expose-gc", "--expose_gc"]) {
    try {
      v8.setFlagsFromString(flag);
      const candidate: unknown = vm.runInNewContext("gc");
      if (typeof candidate === "function") return candidate as () => void;
    } catch {
      // flag 名在当前 Node/V8 版本不被接受时换下一种写法；都不行则返回 null（无 GC 钩子）
    }
  }
  return null;
}

/**
 * 按需执行 full GC，带最小间隔节流。
 *
 * @param minIntervalMs 距上次实际执行不足该毫秒数则跳过（默认 0 = 不节流）
 * @returns 本次是否真的执行了 full GC；拿不到 gc 时恒为 false
 */
export function maybeGc(minIntervalMs = 0): boolean {
  const gc = resolveGc();
  if (!gc) return false;
  const now = Date.now();
  if (minIntervalMs > 0 && now - lastGcAt < minIntervalMs) return false;
  lastGcAt = now;
  gc();
  return true;
}
