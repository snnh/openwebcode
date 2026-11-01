import { chmod, mkdir } from "node:fs/promises";

export function isMissing(error: unknown): boolean {
  // Error.isError：跨 realm 的 Error 也识别（沙盒/扩展宿主经 IPC 传回的错误对象常见）。
  return Error.isError(error) && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** POSIX 下对目标 chmod；Windows 无权限位语义，no-op。 */
export async function chmodPrivate(target: string, mode: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") return;
  await chmod(target, mode);
}

/** mkdir -p 后收紧目录权限（如 0700，POSIX）；Windows 仅创建目录。 */
export async function ensureDirWithMode(dir: string, mode: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chmodPrivate(dir, mode, platform);
}
