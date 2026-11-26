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
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 一条被暂存的 deny 文件：绝对路径 + 回退前的内容与权限位。 */
export interface DenyFileStash {
  path: string;
  content: Buffer;
  /** 回退前的权限位（POSIX mode 位；Windows 无权限位语义，写回时忽略差异）。 */
  mode: number;
  /** 捕获时的 workspace realpath：恢复前再次校验，阻止父目录符号链接逃逸。 */
  workspace: string;
}

function isOutsideRelative(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || !isOutsideRelative(relative);
}

async function workspaceRealPath(workspace: string): Promise<string> {
  return realpath(workspace).catch(() => path.resolve(workspace));
}

/**
 * target 自身或最近存在祖先的 realpath。用于恢复树里可能尚未创建的路径：
 * 父目录不存在时继续向上找，确保最早会落盘的祖先仍在 workspace 内。
 */
async function nearestExistingRealPath(target: string): Promise<string | undefined> {
  let current = path.resolve(target);
  for (;;) {
    try {
      await lstat(current);
      return await realpath(current).catch(() => undefined);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

async function parentIsInside(root: string, target: string): Promise<boolean> {
  const parent = await nearestExistingRealPath(path.dirname(target));
  return parent !== undefined && isWithin(root, parent);
}

/** 供调用方在删除缺失 deny 路径前复用同一套祖先校验。 */
export async function denyPathInsideWorkspace(workspace: string, target: string): Promise<boolean> {
  return parentIsInside(await workspaceRealPath(workspace), target);
}

/** 读取工作区内 deny 文件的当前内容（二进制安全）；缺失/非普通文件/不可读的条目跳过。 */
export async function captureDenyFiles(workspace: string, denyPaths: readonly string[]): Promise<DenyFileStash[]> {
  const stash: DenyFileStash[] = [];
  const root = await workspaceRealPath(workspace);
  for (const denyPath of denyPaths) {
    const absolute = path.resolve(path.isAbsolute(denyPath) ? denyPath : path.join(workspace, denyPath));
    const relative = path.relative(workspace, absolute);
    if (!relative || isOutsideRelative(relative)) continue;
    try {
      // 父目录必须是 workspace 内真实路径；最终组件的 lstat 又不跟随符号链接。
      // 两道检查合起来保证暂存/写回都不会碰工作区外的目标。
      if (!(await parentIsInside(root, absolute))) continue;
      const info = await lstat(absolute);
      if (!info.isFile()) continue;
      stash.push({ path: absolute, content: await readFile(absolute), mode: info.mode, workspace: root });
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
    // 快照可能把父目录恢复成指向工作区外的链接：任何 mkdir/write 之前都先拒绝。
    if (!(await parentIsInside(file.workspace, file.path))) {
      process.stderr.write(`[snapshots] deny restore skipped outside workspace: ${file.path}\n`);
      continue;
    }
    await mkdir(path.dirname(file.path), { recursive: true });
    if (!(await parentIsInside(file.workspace, file.path))) {
      process.stderr.write(`[snapshots] deny restore skipped after mkdir: ${file.path}\n`);
      continue;
    }
    // 快照可能在同路径恢复出符号链接/目录：先移除非普通文件，避免 writeFile 跟随链接
    // 或 EISDIR；普通文件直接覆盖，保留 inode 与硬链接语义。
    const existing = await lstat(file.path).catch(() => undefined);
    if (existing && !existing.isFile()) await rm(file.path, { recursive: true, force: true });
    // writeFile 的 mode 只对新建文件生效；文件已存在（快照里就有）时显式 chmod 保持当前权限位
    await writeFile(file.path, file.content, { mode });
    await chmod(file.path, mode).catch(() => undefined);
  }
}
