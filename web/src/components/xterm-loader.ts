/**
 * xterm 懒加载器（提交⑦）：独立 chunk，仅终端标签建立 PTY 连接时动态 import，
 * 不使用终端不付出入口体积。样式随 chunk 一并按需加载，不进入口 CSS。
 */
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface XtermApi {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
}

let pending: Promise<XtermApi> | undefined;

export function loadXterm(): Promise<XtermApi> {
  // 失败时清空缓存：与 monaco-loader 同因 —— 一次分块加载失败不应让本页内重试永久失败
  pending ??= (async () => {
    const [xterm, fit] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ]);
    return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
  })().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
