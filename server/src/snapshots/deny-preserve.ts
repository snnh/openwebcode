/**
 * 整卷回退（btrfs 换子卷 / zfs 清空重写）的 deny 路径保护。
 *
 * git-shadow 的 restore 用 `git clean -e` 显式排除 deny 路径（恢复不删），但整卷回退
 * 是「用快照的旧树替换当前树」：快照里的旧 .env/.owc 配置会覆盖当前值，检查点之后就
 * 变的 hooks/MCP 配置还会随旧树消失。与 deny 纪律（恢复不删/不覆盖 .env、
 * .owc/hooks.json、.owc/mcp.json）冲突。
 *
 * 做法：回退前把当前 deny 文件内容与权限位暂存内存，回退成功后写回。只暂存回退前
 * 真实存在的普通文件——不存在的 deny 条目一律跳过，不凭 denyPaths 凭空造出文件；
 * 工作区外的 deny 条目不参与（整卷回退不动工作区外的路径）。
 */
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** 一条被暂存的 deny 文件：绝对路径 + 回退前的内容与权限位。 */
export interface DenyFileStash {
  path: string;
  content: Buffer;
  /** 回退前的权限位（POSIX mode 位；Windows 无权限位语义，写回时忽略差异）。 */
  mode: number;
}

/** 读取工作区内 deny 文件的当前内容（二进制安全）；缺失/非普通文件/不可读的条目跳过。 */
export async function captureDenyFiles(workspace: string, denyPaths: readonly string[]): Promise<DenyFileStash[]> {
  const stash: DenyFileStash[] = [];
  for (const denyPath of denyPaths) {
    const absolute = path.resolve(path.isAbsolute(denyPath) ? denyPath : path.join(workspace, denyPath));
    const relative = path.relative(workspace, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) continue;
      stash.push({ path: absolute, content: await readFile(absolute), mode: info.mode });
    } catch {
      // 回退前不存在/不可读：不暂存，回退后也不写回（不新增）
    }
  }
  return stash;
}

/** 把暂存内容写回原位（保持回退前的权限位）；上层目录随回退结果补齐。 */
export async function restoreDenyFiles(stash: readonly DenyFileStash[]): Promise<void> {
  for (const file of stash) {
    const mode = file.mode & 0o777;
    await mkdir(path.dirname(file.path), { recursive: true });
    // writeFile 的 mode 只对新建文件生效；文件已存在（快照里就有）时显式 chmod 保持当前权限位
    await writeFile(file.path, file.content, { mode });
    await chmod(file.path, mode).catch(() => undefined);
  }
}
