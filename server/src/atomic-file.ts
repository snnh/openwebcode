import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";

/**
 * Windows does not allow an existing file to be atomically replaced while a
 * virus scanner, indexer, or another short-lived reader has it open.  Our
 * session data is read frequently, so retry only these transient sharing
 * failures and keep the old file intact until rename succeeds.
 */
// Windows Defender/indexers occasionally retain a handle for several seconds.
// Keep the retry bounded while allowing a normal request to survive that delay.
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1_200, 1_200, 1_500] as const;

interface AtomicReplaceOptions {
  /** Injectable solely for focused tests. */
  platform?: NodeJS.Platform;
  retryDelaysMs?: readonly number[];
  renameFile?: (from: string, to: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  /** 写后目标文件权限位（POSIX chmod，如 0o600）；Windows 无权限位语义，no-op。 */
  mode?: number;
  /** Injectable solely for focused tests. */
  chmodFile?: (target: string, mode: number) => Promise<void>;
}

function isTransientWindowsRenameError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ["EPERM", "EACCES", "EBUSY"].includes(String((error as NodeJS.ErrnoException).code));
}

/** Replace an already-written temporary file without ever deleting the target first. */
export async function replaceFileWithRetry(temporary: string, target: string, options: AtomicReplaceOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const delays = platform === "win32" ? (options.retryDelaysMs ?? WINDOWS_RENAME_RETRY_DELAYS_MS) : [];
  const renameFile = options.renameFile ?? rename;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(temporary, target);
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (!isTransientWindowsRenameError(error) || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

/** Write UTF-8 text through a unique sibling temporary file, then atomically replace with Windows retry. */
export async function writeUtf8Atomically(target: string, content: string, options: AtomicReplaceOptions = {}): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // mode 在创建临时文件时即生效（POSIX）：宽松 umask 下不留 rename 前的可读窗口；
    // Windows 无权限位语义，由 Node 忽略（no-op）。rename 后的 chmod 保留作兜底。
    await writeFile(temporary, content, { encoding: "utf8", ...(options.mode !== undefined ? { mode: options.mode } : {}) });
    await replaceFileWithRetry(temporary, target, options);
    if (options.mode !== undefined && (options.platform ?? process.platform) !== "win32") {
      await (options.chmodFile ?? chmod)(target, options.mode);
    }
  } finally {
    // rename removes the temporary name on success.  Cleanup is best effort so
    // a failed cleanup never hides the original write/rename error.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
