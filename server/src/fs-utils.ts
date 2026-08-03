import { chmod, mkdir } from "node:fs/promises";

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
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
