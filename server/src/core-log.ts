import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** core.log 超过该字节数时在启动时轮转为 core.log.1（覆盖旧的，只保留一代）。 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * core stderr/diagnostic 归档：<logDir>/core.log 追加写入；写失败静默吞掉，
 * 永不阻断主流程（stderr 转发不受影响）。
 */
export class CoreLogArchive {
  private readonly filePath: string;
  /** 追加串行化：保证日志行序与事件顺序一致；失败仅断开当次写入。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(logDir: string, private readonly maxBytes: number = DEFAULT_MAX_BYTES) {
    this.filePath = path.join(logDir, "core.log");
  }

  /** 创建目录并按大小轮转：core.log -> core.log.1（先删旧的一代，Windows rename 不覆盖）。 */
  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (size <= this.maxBytes) return;
    await rm(`${this.filePath}.1`, { force: true });
    await rename(this.filePath, `${this.filePath}.1`);
  }

  /** 追加一行；失败静默（日志归档是尽力而为的旁路）。 */
  append(text: string): void {
    this.queue = this.queue.then(() => appendFile(this.filePath, text, "utf8")).then(() => undefined, () => undefined);
  }
}
