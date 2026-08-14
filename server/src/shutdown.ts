/**
 * 优雅退出加固：
 * - 首次 SIGINT/SIGTERM（POSIX 含 SIGHUP）启动优雅 shutdown，同时挂 5s 超时，超时强制 exit(1)；
 * - 同一信号第二次到达立即按 128+signum 退出（130/143/129），不再等待；
 * - shutdown 成功则清超时、交给事件循环自然退出（保持既有行为）；失败则 exit(1)。
 */

const EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

interface GracefulShutdownOptions {
  shutdown: () => Promise<void>;
  /** 优雅 shutdown 的超时（毫秒），超时强制 exit(1)。 */
  forceExitTimeoutMs?: number;
  /** 测试注入；默认 process.exit。 */
  exit?: (code: number) => void;
  /** 测试注入；默认 process.platform。 */
  platform?: NodeJS.Platform;
  /** 测试注入；默认 process.on。 */
  register?: (signal: NodeJS.Signals, listener: () => void) => void;
}

export function installGracefulShutdown(options: GracefulShutdownOptions): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const platform = options.platform ?? process.platform;
  const register = options.register ?? ((signal: NodeJS.Signals, listener: () => void) => process.on(signal, listener));
  const timeoutMs = options.forceExitTimeoutMs ?? 5_000;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  if (platform !== "win32") signals.push("SIGHUP");
  const started = new Set<string>();
  for (const signal of signals) {
    register(signal, () => {
      if (started.has(signal)) {
        exit(EXIT_CODES[signal] ?? 1);
        return;
      }
      started.add(signal);
      const timer = setTimeout(() => exit(1), timeoutMs);
      timer.unref();
      void options.shutdown().then(
        () => clearTimeout(timer),
        (error: unknown) => {
          clearTimeout(timer);
          process.stderr.write(`[shutdown] 优雅退出失败：${error instanceof Error ? error.message : String(error)}\n`);
          exit(1);
        },
      );
    });
  }
}
