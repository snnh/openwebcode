import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SnapshotBackend } from "./backend.js";
import { BtrfsBackend } from "./btrfs.js";
import { GitShadowSnapshots } from "./git-shadow.js";
import { RefsBackend, refsScriptPath } from "./refs.js";
import { ZfsBackend } from "./zfs.js";

export interface CommandRunner {
  run(cmd: string, args: string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; code: number }>;
}

/** 默认 runner：execFile 包装；非零退出/超时/命令不存在都归一为 code，不 throw。 */
export function createExecFileRunner(): CommandRunner {
  return {
    run: (cmd, args, options) => new Promise((resolve) => {
      execFile(cmd, args, { timeout: options?.timeoutMs ?? 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (!error) {
          resolve({ stdout: String(stdout), code: 0 });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        resolve({ stdout: String(stdout ?? ""), code: typeof code === "number" ? code : 1 });
      });
    }),
  };
}

/**
 * 探测快照后端。任何一步异常都吞掉继续向下；全程不 throw。
 * linux：btrfs → zfs → git shadow；win32：ReFS → git shadow；其他平台：git shadow。
 */
export async function probeSnapshotBackend(
  sessionRoot: string,
  workspace: string,
  deps: { runner?: CommandRunner; platform?: NodeJS.Platform },
): Promise<SnapshotBackend> {
  const runner = deps.runner ?? createExecFileRunner();
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "linux") {
      const btrfs = await probeBtrfs(workspace, runner);
      if (btrfs) return btrfs;
      const zfs = await probeZfs(sessionRoot, workspace, runner);
      if (zfs) return zfs;
    } else if (platform === "win32") {
      const refs = await probeRefs(sessionRoot, workspace, runner);
      if (refs) return refs;
    }
  } catch { /* 继续回落 */ }
  return new GitShadowSnapshots(sessionRoot, workspace);
}

async function probeBtrfs(workspace: string, runner: CommandRunner): Promise<SnapshotBackend | undefined> {
  try {
    const stat = await runner.run("stat", ["-f", "-c", "%T", workspace]);
    if (stat.code !== 0 || !stat.stdout.includes("btrfs")) return undefined;
    const show = await runner.run("btrfs", ["subvolume", "show", workspace]);
    if (show.code !== 0) return undefined;
    return new BtrfsBackend(workspace, runner);
  } catch {
    return undefined;
  }
}

async function probeZfs(sessionRoot: string, workspace: string, runner: CommandRunner): Promise<SnapshotBackend | undefined> {
  try {
    const fstype = await runner.run("findmnt", ["-n", "-o", "FSTYPE", "--target", workspace]);
    if (fstype.code !== 0 || fstype.stdout.trim() !== "zfs") return undefined;
    const source = await runner.run("findmnt", ["-n", "-o", "SOURCE", "--target", workspace]);
    const dataset = source.stdout.trim();
    if (source.code !== 0 || !dataset) return undefined;
    const list = await runner.run("zfs", ["list", "-H", "-o", "name", dataset]);
    if (list.code !== 0) return undefined;
    // 数据集挂载点必须正是工作区本身（避免把父数据集误判为工作区快照对象）
    const mount = await runner.run("zfs", ["list", "-H", "-o", "mountpoint", dataset]);
    if (mount.code !== 0 || path.resolve(mount.stdout.trim()) !== path.resolve(workspace)) return undefined;
    return new ZfsBackend(sessionRoot, workspace, dataset, runner);
  } catch {
    return undefined;
  }
}

async function probeRefs(sessionRoot: string, workspace: string, runner: CommandRunner): Promise<SnapshotBackend | undefined> {
  try {
    if (!existsSync(refsScriptPath())) return undefined;
    // sessionRoot 与 workspace 必须同盘符，才可能落在同一 ReFS 卷
    const drive = driveLetter(workspace);
    if (!drive || driveLetter(sessionRoot) !== drive) return undefined;
    const result = await runner.run("powershell", ["-NoProfile", "-Command", `(Get-Volume -DriveLetter ${drive}).FileSystem -eq 'ReFS'`]);
    if (result.code !== 0 || !result.stdout.trim().toLowerCase().startsWith("true")) return undefined;
    return new RefsBackend(sessionRoot, workspace, runner);
  } catch {
    return undefined;
  }
}

function driveLetter(target: string): string | undefined {
  return /^([A-Za-z]):[\\/]/.exec(target)?.[1]?.toUpperCase();
}
