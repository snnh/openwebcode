/**
 * 前端崩溃记录（0.6.0 白屏护栏）：环形缓冲保存最近若干条未捕获异常 / 渲染失败 /
 * 分块加载失败，供兜底界面展示与「复制诊断」用（不落盘、不联网，会话内有效）。
 *
 * 为什么需要：渲染期与生命周期里抛出的异常会让 React 卸载整棵树（白屏），
 * 而白屏现场没有任何可读信息——没有记录就只能靠用户复述。
 */

export type CrashKind = "render" | "error" | "unhandledrejection" | "chunk";

export interface CrashRecord {
  /** ISO 时间戳 */
  at: string;
  kind: CrashKind;
  /** 一行摘要（异常 message） */
  message: string;
  /** 区域名 / 脚本地址等定位信息 */
  context?: string;
  /** 堆栈（有则带） */
  stack?: string;
}

const MAX_RECORDS = 20;
const records: CrashRecord[] = [];

/** 记录一条崩溃（同时打到 console.error，便于开发时直接看到）。 */
export function recordCrash(kind: CrashKind, error: unknown, context?: string): CrashRecord {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const record: CrashRecord = {
    at: new Date().toISOString(),
    kind,
    message: message.slice(0, 500),
    ...(context ? { context: context.slice(0, 300) } : {}),
    ...(stack ? { stack: stack.slice(0, 4000) } : {}),
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  // 崩溃现场必须留下可见线索（本项目 lint 未启用 no-console）
  console.error(`[owc:${kind}]${context ? ` ${context}` : ""}`, error);
  return record;
}

export function crashRecords(): CrashRecord[] {
  return [...records];
}

export function clearCrashRecords(): void {
  records.length = 0;
}

/** 纯文本诊断报告（可整段复制给维护者；不含会话内容与凭据）。 */
export function crashReport(): string {
  const header = [
    `url: ${typeof window === "undefined" ? "-" : window.location.href}`,
    `ua: ${typeof navigator === "undefined" ? "-" : navigator.userAgent}`,
    `at: ${new Date().toISOString()}`,
  ];
  const body = crashRecords().map((record) =>
    `--- ${record.at} [${record.kind}]${record.context ? ` ${record.context}` : ""}\n${record.message}${record.stack ? `\n${record.stack}` : ""}`);
  return [...header, ...body].join("\n");
}

/**
 * 安装全局兜底钩子（入口模块顶层调用，早于 React 渲染）：
 * - `vite:preloadError`：动态分块加载失败（发版后旧页面引用已删除的 chunk 是常见成因）。
 *   这里吞掉默认错误并**节流自动重载一次**——重新加载会拿到新 manifest；重复失败不再重载，
 *   由 ErrorBoundary / 兜底界面提示手动刷新，避免刷新风暴。
 * - `error` / `unhandledrejection`：只记录（非渲染错误不会卸载 React 树），
 *   现场线索在兜底界面的「复制诊断」里可见。
 */
const RELOAD_GUARD_KEY = "owc-chunk-reload-at";
const RELOAD_MIN_INTERVAL_MS = 15_000;

export function installBootGuards(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    recordCrash("chunk", payload ?? new Error("dynamic import failed"), "vite:preloadError");
    event.preventDefault();
    if (reloadedRecently()) return;
    try {
      window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      // 隐私模式下 sessionStorage 不可写：退化为不自动重载（避免死循环）
      return;
    }
    window.location.reload();
  });
  window.addEventListener("error", (event) => {
    // 资源加载失败（script/link/img）不带 error 对象，仍值得记录
    recordCrash("error", event.error ?? new Error(event.message || "resource load failed"), event.filename || undefined);
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordCrash("unhandledrejection", event.reason, "promise");
  });
}

function reloadedRecently(): boolean {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_GUARD_KEY);
    return raw !== null && Date.now() - Number(raw) < RELOAD_MIN_INTERVAL_MS;
  } catch {
    return true;
  }
}
