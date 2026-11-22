import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as treeDiffModule from "../src/snapshots/tree-diff.js";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { CoreRpcError, type CoreClient, type CoreInfo } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { activePathMessages } from "../src/sessions/session-tree.js";
import { readCheckpoints, writeCheckpoints, type SnapshotBackend } from "../src/snapshots/backend.js";
import { acquireSnapshotSessionLock, beginSessionMutation, beginTerminalOpen } from "../src/snapshots/session-lock.js";
import { BtrfsBackend } from "../src/snapshots/btrfs.js";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";
import { probeSnapshotBackend, probeSnapshotBackendByName, type CommandRunner, type SnapshotProbeDeps } from "../src/snapshots/probe.js";
import type { OverlayfsCore } from "../src/snapshots/overlayfs.js";
import { ZfsBackend } from "../src/snapshots/zfs.js";
import { ManagedDiskBackend } from "../src/snapshots/managed-disk.js";
import { OverlayfsBackend, overlayfsPaths } from "../src/snapshots/overlayfs.js";
import { FAKE_CORE_INFO } from "./helpers/fake-core.js";
import { recordingRunner, tableRunner } from "./helpers/recording-runner.js";
import { tempRoot } from "./helpers/temp-roots.js";

const execFileAsync = promisify(execFile);
const SESSION = "/data/sess";
const WS = "/data/ws";
const WIN_SESSION = "C:\\owc\\sess";
const WIN_WS = "C:\\data\\ws";
const SNAP_ID = "snap-1-abcdef";
const REFS_CMD = "powershell -NoProfile -Command (Get-Volume -DriveLetter C).FileSystem -eq 'ReFS'";
type Table = Record<string, { stdout?: string; code?: number }>;
const BTRFS: Table = { [`stat -f -c %T ${WS}`]: { stdout: "btrfs\n", code: 0 }, [`btrfs subvolume show ${WS}`]: { code: 0 } };
const ZFS: Table = {
  [`stat -f -c %T ${WS}`]: { stdout: "ext4\n", code: 0 }, [`findmnt -n -o FSTYPE --target ${WS}`]: { stdout: "zfs\n", code: 0 },
  [`findmnt -n -o SOURCE --target ${WS}`]: { stdout: "tank/ws\n", code: 0 }, [`zfs list -H -o name tank/ws`]: { stdout: "tank/ws\n", code: 0 },
  [`zfs list -H -o mountpoint tank/ws`]: { stdout: `${WS}\n`, code: 0 },
};

/** 批量写文件（相对路径 → 内容），必要时建父目录。 */
async function writeFiles(dir: string, files: Record<string, string>) {
  await Promise.all(Object.entries(files).map(async ([name, content]) => {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), content, "utf8");
  }));
}
/** 临时 root + <root>/ws 工作区。 */
async function tempWorkspace(prefix: string, files: Record<string, string> = {}) {
  const root = await tempRoot(prefix);
  const workspace = path.join(root, "ws");
  await mkdir(workspace, { recursive: true });
  await writeFiles(workspace, files);
  return { root, workspace };
}
/** fake core：ping 按参数上报 features.overlay；linux 平台。 */
function overlayCore(supported: boolean): OverlayfsCore {
  return { ping: async () => ({ ...FAKE_CORE_INFO, platform: "linux", features: { ...FAKE_CORE_INFO.features, overlay: { supported, fuseOverlayfs: true, kernelMount: false } } }) as CoreInfo };
}
/** 探测快捷入口（表驱动 runner + 可选 core/excludes/denyPaths/路径注入）。 */
function probeLinux(table: Table = {}, deps: Partial<SnapshotProbeDeps> = {}, session = SESSION, workspace = WS) {
  return probeSnapshotBackend(session, workspace, { ...deps, runner: deps.runner ?? tableRunner(table).runner, platform: "linux" });
}
function probeWin(table: Table = {}, deps: Partial<SnapshotProbeDeps> = {}, workspace = WIN_WS) {
  return probeSnapshotBackend(WIN_SESSION, workspace, { ...deps, runner: deps.runner ?? tableRunner(table).runner, platform: "win32" });
}
function probeByName(name: string, deps: Partial<SnapshotProbeDeps>, platform: NodeJS.Platform = "linux") {
  return probeSnapshotBackendByName(name, SESSION, WS, { ...deps, platform, runner: deps.runner ?? tableRunner({}).runner });
}
const quiet = () => recordingRunner(() => ({ code: 0 })).runner;

describe("probeSnapshotBackend 探测链", () => {
  it("linux：btrfs 优先，其次 zfs/overlayfs，最后 git-shadow；异常静默回落，能力字段随实例上报", async () => {
    expect((await probeLinux(BTRFS)).name).toBe("btrfs");
    expect((await probeLinux({ ...ZFS, ...BTRFS }, { core: overlayCore(true) })).name).toBe("btrfs"); // 探测链位置先于 zfs/overlayfs
    expect((await probeLinux(ZFS, { core: overlayCore(true) })).name).toBe("zfs");
    expect((await probeLinux({}, { core: overlayCore(true) })).name).toBe("overlayfs");
    expect((await probeLinux({}, { core: overlayCore(false) })).name).toBe("git-shadow");
    expect((await probeLinux()).name).toBe("git-shadow"); // 未注入 core
    expect((await probeLinux({}, { core: { ping: async () => { throw new Error("core down"); } } })).name).toBe("git-shadow"); // core.ping 异常
    const thrower: CommandRunner = { run: async () => { throw new Error("spawn failed"); } };
    expect((await probeLinux({}, { runner: thrower })).name).toBe("git-shadow"); // 探测命令异常，全程不 throw
    expect(await (await probeLinux(BTRFS)).capability()).toMatchObject({ backend: "btrfs", costHint: "instant", requiresAdmin: false });
    expect(await (await probeLinux(ZFS)).capability()).toMatchObject({ backend: "zfs", costHint: "instant", requiresAdmin: false });
    // git-shadow 的 capability 会真跑 git --version：工作区必须存在
    const { workspace } = await tempWorkspace("owc-probe-cap-");
    expect(await (await probeLinux({}, {}, SESSION, workspace)).capability()).toMatchObject({ backend: "git-shadow", costHint: "linear", requiresAdmin: false });
    // 单后端偏好探测：命中/平台不符/未知名一律 undefined，不回落探测链
    expect((await probeByName("btrfs", { runner: tableRunner(BTRFS).runner }))?.name).toBe("btrfs");
    expect(await probeByName("btrfs", { runner: tableRunner({ [`stat -f -c %T ${WS}`]: { stdout: "ext4\n", code: 0 } }).runner })).toBeUndefined();
    expect(await probeByName("btrfs", {}, "win32")).toBeUndefined();
    expect(await probeByName("refs", {}, "linux")).toBeUndefined();
    expect((await probeByName("overlayfs", { core: overlayCore(true) }))?.name).toBe("overlayfs");
    expect(await probeByName("overlayfs", {})).toBeUndefined();
    expect((await probeByName("git-shadow", {}))?.name).toBe("git-shadow");
    expect(await probeByName("zfs-with-dataset", {})).toBeUndefined();
  });
  it("win32：ReFS 命中；非 ReFS / 跨盘符 / 注入 overlay 均回落 git-shadow", async () => {
    const refs = await probeWin({ [REFS_CMD]: { stdout: "True\r\n", code: 0 } });
    expect(refs.name).toBe("refs");
    expect(await refs.capability()).toMatchObject({ backend: "refs", costHint: "instant", requiresAdmin: false });
    expect((await probeWin({ [REFS_CMD]: { stdout: "False\r\n", code: 0 } })).name).toBe("git-shadow");
    expect((await probeWin({}, { core: overlayCore(true) })).name).toBe("git-shadow");
    expect((await probeWin({}, { runner: tableRunner({}).runner }, "C:\\data\\ws")).name).toBe("git-shadow");
    const crossDrive = tableRunner({});
    expect((await probeWin({}, { runner: crossDrive.runner }, "D:\\data\\ws")).name).toBe("git-shadow");
    expect(crossDrive.calls).toHaveLength(0); // 跨盘符不做任何探测
  });
  // B10：现场探测实例必须与 constructByName 同参数携带 excludes/denyPaths，否则首次 diff/回退会漏掉 deny
  it("探测出的实例携带会话 excludes 与 denyPaths：首次 diff 用 excludes，回退保留 deny 当前内容", async () => {
    const { root, workspace } = await tempWorkspace("owc-probe-deny-", { ".env": "SECRET=current" });
    const denyPaths = [path.join(workspace, ".env")];
    const excludes = { excludePrefixes: [".env"], excludeGlobs: [] };
    const spy = vi.spyOn(treeDiffModule, "diffTrees").mockResolvedValue("unified diff");
    try {
      const runner = recordingRunner((cmd, args) => {
        if (cmd === "stat") return { stdout: "btrfs\n", code: 0 };
        // 只在 restore 的快照（无 -r）时物化「快照内容」（含旧 .env）
        if (args[1] === "snapshot" && args[2] !== "-r") { mkdirSync(workspace, { recursive: true }); writeFileSync(path.join(workspace, ".env"), "SECRET=snapshot-old"); }
        return { code: 0 };
      });
      const probed = await probeLinux({}, { runner: runner.runner, excludes, denyPaths }, path.join(root, "sess"), workspace);
      expect(probed.name).toBe("btrfs");
      await probed.diff(SNAP_ID);
      expect(spy).toHaveBeenLastCalledWith(path.join(root, ".owc-snapshots", "ws", SNAP_ID), workspace, excludes);
      const checkpoint = await probed.create("label", 0);
      await probed.restore(checkpoint.id);
      expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=current");
      const refs = await probeWin({ [REFS_CMD]: { stdout: "True\r\n", code: 0 } }, { excludes });
      expect(refs.name).toBe("refs");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("BtrfsBackend", () => {
  it("create/list/delete 维护元数据与命令序列；diff 退出码 1 = 有差异、>1 抛错", async () => {
    const { workspace } = await tempWorkspace("owc-btrfs-");
    const snapRoot = path.join(path.dirname(workspace), ".owc-snapshots", "ws"); // 快照根与工作区同父目录
    const recorded = recordingRunner(() => ({ code: 0 }));
    const backend = new BtrfsBackend(workspace, recorded.runner);
    const checkpoint = await backend.create("label", 3, { round: 1 }, "leaf-1");
    expect(recorded.calls[0]).toEqual({ cmd: "btrfs", args: ["subvolume", "snapshot", "-r", workspace, path.join(snapRoot, checkpoint.id)] });
    expect(await backend.list()).toMatchObject([{ id: checkpoint.id, label: "label", messageCount: 3, activeLeafId: "leaf-1", ledger: { round: 1 } }]);
    // 元数据与 git shadow 同形状数组，存于 snapRoot/checkpoints.json
    expect(Array.isArray(JSON.parse(await readFile(path.join(snapRoot, "checkpoints.json"), "utf8")))).toBe(true);
    await backend.delete(checkpoint.id);
    expect(recorded.calls[1]).toEqual({ cmd: "btrfs", args: ["subvolume", "delete", path.join(snapRoot, checkpoint.id)] });
    expect(await backend.list()).toEqual([]);
    // diffTrees 返回 null（git 缺失）时降级到 btrfs 摘要：码 1 有差异、>1 抛错
    const spy = vi.spyOn(treeDiffModule, "diffTrees").mockResolvedValue(null);
    try {
      await expect(new BtrfsBackend(workspace, recordingRunner(() => ({ stdout: "Files a and b differ\n", code: 1 })).runner).diff(SNAP_ID)).resolves.toContain("Files a and b differ");
      await expect(new BtrfsBackend(workspace, recordingRunner(() => ({ code: 2 })).runner).diff(SNAP_ID)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
  it("restore 先验证快照源、改名旧子卷再从快照重建、失败回滚；整卷回退保留 deny 当前内容", async () => {
    const { root, workspace } = await tempWorkspace("owc-btrfs-", { "keep.txt": "current" });
    const recorded = recordingRunner(() => ({ code: 0 }));
    const checkpoint = await new BtrfsBackend(workspace, recorded.runner).create("label", 0);
    const snapRoot = path.join(root, ".owc-snapshots", "ws");
    // 快照源不可用：在动工作区之前失败；重建失败：旧子卷改名回原位，临时改名残留已收回
    const badSource = recordingRunner((_cmd, args) => (args[1] === "show" ? { code: 1 } : { code: 0 }));
    await expect(new BtrfsBackend(workspace, badSource.runner).restore(checkpoint.id)).rejects.toThrow(/btrfs subvolume show failed/);
    const failing = recordingRunner((_cmd, args) => (args[1] === "snapshot" ? { code: 1 } : { code: 0 }));
    await expect(new BtrfsBackend(workspace, failing.runner).restore(checkpoint.id)).rejects.toThrow(/btrfs snapshot failed/);
    expect(await readFile(path.join(workspace, "keep.txt"), "utf8")).toBe("current");
    expect((await readdir(root)).filter((entry) => entry.startsWith("ws.owc-restore-"))).toEqual([]);
    // 成功路径：验证快照源 → 重建 → 清理旧子卷（工作区路径本身不做 delete）
    recorded.calls.length = 0;
    await new BtrfsBackend(workspace, recorded.runner).restore(checkpoint.id);
    expect(recorded.calls.map((call) => call.args)).toMatchObject([
      ["subvolume", "show", path.join(snapRoot, checkpoint.id)],
      ["subvolume", "snapshot", path.join(snapRoot, checkpoint.id), workspace],
      ["subvolume", "delete", expect.stringMatching(/ws\.owc-restore-/)],
    ]); // 工作区路径本身不做 delete（旧序列是先删再建）
    // 当前 deny 内容回写：不覆盖当前 .env、不凭空造出快照里没有的 deny 文件
    const deny = await tempWorkspace("owc-btrfs-deny-", { ".env": "SECRET=current" });
    const denyPaths = [path.join(deny.workspace, ".env"), path.join(deny.workspace, ".owc", "hooks.json")];
    const denyCheckpoint = await new BtrfsBackend(deny.workspace, quiet(), undefined, denyPaths).create("label", 0);
    const materialize = recordingRunner((_cmd, args) => {
      if (args[1] === "snapshot") { mkdirSync(deny.workspace, { recursive: true }); writeFileSync(path.join(deny.workspace, ".env"), "SECRET=snapshot-old"); }
      return { code: 0 };
    });
    await new BtrfsBackend(deny.workspace, materialize.runner, undefined, denyPaths).restore(denyCheckpoint.id);
    expect(await readFile(path.join(deny.workspace, ".env"), "utf8")).toBe("SECRET=current");
    await expect(stat(path.join(deny.workspace, ".owc", "hooks.json"))).rejects.toThrow();
  });
});

describe("ZfsBackend", () => {
  /** ZFS 夹具：工作区（a.txt/sub/b.txt）+ 可见快照目录（旧 a.txt）+ checkpoints.json。 */
  async function zfsRig(options: { snapshot?: boolean; checkpoint?: boolean } = {}) {
    const { root, workspace } = await tempWorkspace("owc-zfs-", { "a.txt": "current", "sub/b.txt": "extra" });
    const sessionRoot = path.join(root, "sess");
    if (options.snapshot ?? true) await writeFiles(path.join(workspace, ".zfs", "snapshot", SNAP_ID), { "a.txt": "old" });
    await mkdir(sessionRoot, { recursive: true });
    if (options.checkpoint ?? true) await writeCheckpoints(path.join(sessionRoot, "checkpoints.json"), [{ id: SNAP_ID, label: "l", createdAt: new Date().toISOString(), messageCount: 1 }]);
    return { root, sessionRoot, workspace, id: SNAP_ID };
  }
  it("create/diff/delete 命令与元数据正确", async () => {
    const rig = await zfsRig({ snapshot: false, checkpoint: false });
    const recorded = recordingRunner(() => ({ code: 0 }));
    const backend = new ZfsBackend(rig.sessionRoot, rig.workspace, "tank/ws", recorded.runner);
    const checkpoint = await backend.create("label", 2, { round: 2 }, "leaf-2");
    expect(recorded.calls[0]).toEqual({ cmd: "zfs", args: ["snapshot", `tank/ws@${checkpoint.id}`] });
    expect(checkpoint.activeLeafId).toBe("leaf-2");
    expect(await backend.list()).toMatchObject([{ id: checkpoint.id, activeLeafId: "leaf-2", ledger: { round: 2 } }]);
    const raw = JSON.parse(await readFile(path.join(rig.sessionRoot, "checkpoints.json"), "utf8")) as Array<{ id: string }>;
    expect(raw.map((item) => item.id)).toEqual([checkpoint.id]);
    await expect(new ZfsBackend(rig.sessionRoot, rig.workspace, "tank/ws", recordingRunner(() => ({ stdout: "M\t/ws/a.txt\n", code: 0 })).runner).diff(checkpoint.id)).resolves.toBe("M\t/ws/a.txt\n");
    await backend.delete(checkpoint.id);
    expect(recorded.calls[1]).toEqual({ cmd: "zfs", args: ["destroy", `tank/ws@${checkpoint.id}`] });
    expect(await backend.list()).toEqual([]);
  });
  it("restore 清空工作区（跳过 .zfs）并从只读快照复制回写；复制失败回滚、快照源不可读不动工作区、deny 文件保留", async () => {
    const rig = await zfsRig();
    await new ZfsBackend(rig.sessionRoot, rig.workspace, "tank/ws", quiet()).restore(rig.id);
    expect(await readFile(path.join(rig.workspace, "a.txt"), "utf8")).toBe("old");
    await expect(stat(path.join(rig.workspace, "sub"))).rejects.toThrow(); // 快照里没有的路径被清掉
    expect((await stat(path.join(rig.workspace, ".zfs"))).isDirectory()).toBe(true); // .zfs 目录本身保留
    expect((await readdir(rig.workspace)).filter((entry) => entry.startsWith(".owc-restore-"))).toEqual([]);
    const failing = await zfsRig();
    class FailingZfs extends ZfsBackend {
      protected override async copyFromSnapshot(): Promise<void> { throw new Error("copy failed"); }
    }
    await expect(new FailingZfs(failing.sessionRoot, failing.workspace, "tank/ws", quiet()).restore(failing.id)).rejects.toThrow(/copy failed/);
    expect(await readFile(path.join(failing.workspace, "a.txt"), "utf8")).toBe("current"); // 回滚：数据不丢
    expect(await readFile(path.join(failing.workspace, "sub", "b.txt"), "utf8")).toBe("extra");
    expect((await readdir(failing.workspace)).filter((entry) => entry.startsWith(".owc-restore-"))).toEqual([]);
    expect((await stat(path.join(failing.workspace, ".zfs"))).isDirectory()).toBe(true);
    const missing = await zfsRig({ snapshot: false });
    await expect(new ZfsBackend(missing.sessionRoot, missing.workspace, "tank/ws", quiet()).restore(missing.id)).rejects.toThrow(/not accessible/);
    expect(await readFile(path.join(missing.workspace, "a.txt"), "utf8")).toBe("current");
    // deny 文件：整卷替换保留当前内容与权限位，不新增快照里没有的 deny 文件
    const deny = await zfsRig({ snapshot: false });
    await writeFile(path.join(deny.workspace, ".env"), "SECRET=current", { encoding: "utf8", mode: 0o600 });
    await writeFiles(deny.workspace, { ".owc/mcp.json": "current-mcp", "mod.txt": "current" });
    await writeFiles(path.join(deny.workspace, ".zfs", "snapshot", SNAP_ID), { ".env": "SECRET=snapshot-old", "mod.txt": "old" });
    const denyPaths = [path.join(deny.workspace, ".env"), path.join(deny.workspace, ".owc", "mcp.json"), path.join(deny.workspace, ".owc", "hooks.json")];
    await new ZfsBackend(deny.sessionRoot, deny.workspace, "tank/ws", quiet(), undefined, denyPaths).restore(SNAP_ID);
    expect(await readFile(path.join(deny.workspace, "mod.txt"), "utf8")).toBe("old"); // 普通文件回到快照内容
    expect(await readFile(path.join(deny.workspace, ".env"), "utf8")).toBe("SECRET=current");
    // 权限位只在 POSIX 断言：Windows 的 stat().mode 是合成值（全部 0o666），chmod 语义也不同
    if (process.platform !== "win32") expect((await stat(path.join(deny.workspace, ".env"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(deny.workspace, ".owc", "mcp.json"), "utf8")).toBe("current-mcp");
    await expect(stat(path.join(deny.workspace, ".owc", "hooks.json"))).rejects.toThrow();
  });

});

describe("检查点元数据兼容", () => {
  it("损坏的 activeLeafId 只丢字段，不丢整个检查点", async () => {
    const root = await tempRoot("owc-checkpoint-meta-");
    const file = path.join(root, "checkpoints.json");
    const base = { label: "cp", createdAt: new Date().toISOString(), messageCount: 1 };
    await writeFile(file, JSON.stringify([
      { ...base, id: "snap-1-abcdef", activeLeafId: "leaf-1" },
      { ...base, id: "snap-2-abcdef", activeLeafId: 7 },
    ]), "utf8");
    const list = await readCheckpoints(file);
    expect(list.map((item) => item.id)).toEqual(["snap-1-abcdef", "snap-2-abcdef"]);
    expect(list[0]?.activeLeafId).toBe("leaf-1");
    expect("activeLeafId" in list[1]!).toBe(false);
  });
});

describe("快照/终端 per-session 门禁", () => {
  it("pending 终端与普通 mutation 阻断快照锁；锁内不能再开终端", () => {
    const id = `owc-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const terminal = beginTerminalOpen(id);
    expect(terminal).toBeDefined();
    try {
      expect(acquireSnapshotSessionLock(id)).toBeUndefined();
    } finally {
      terminal?.();
    }
    const mutation = beginSessionMutation(id);
    expect(mutation).toBeDefined();
    try {
      expect(acquireSnapshotSessionLock(id)).toBeUndefined();
    } finally {
      mutation?.();
    }
    const lock = acquireSnapshotSessionLock(id);
    expect(lock).toBeDefined();
    try {
      expect(beginTerminalOpen(id)).toBeUndefined();
      expect(beginSessionMutation(id)).toBeUndefined();
    } finally {
      lock?.();
    }
    const finalLock = acquireSnapshotSessionLock(id);
    expect(finalLock).toBeDefined();
    finalLock?.();
  });
});

describe("OverlayfsBackend 回滚事务", () => {
  const id = SNAP_ID;
  const coreInfo = { ...FAKE_CORE_INFO, platform: "linux" as const, features: { ...FAKE_CORE_INFO.features, overlay: { supported: true, fuseOverlayfs: true, kernelMount: false } } } as CoreInfo;
  async function rig() {
    const root = await tempRoot("owc-overlay-");
    const origin = path.join(root, "origin");
    const sessionRoot = path.join(root, "sess");
    await mkdir(origin, { recursive: true });
    await writeFile(path.join(origin, "lower.txt"), "lower");
    const paths = overlayfsPaths(sessionRoot);
    await mkdir(paths.upper, { recursive: true });
    await mkdir(paths.work, { recursive: true });
    await mkdir(paths.merged, { recursive: true });
    await mkdir(paths.checkpointsDir, { recursive: true });
    await writeFiles(paths.upper, { "current.txt": "current" });
    await writeFiles(path.join(paths.checkpointsDir, id), { "old.txt": "old" });
    await writeCheckpoints(paths.checkpointsFile, [{ id, label: "cp", createdAt: new Date().toISOString(), messageCount: 1 }]);
    return { origin, sessionRoot, paths };
  }
  function fakeCore(options: { failRestoreOnce?: boolean; failRecovery?: boolean; busyRestore?: boolean } = {}) {
    const calls: string[] = [];
    let restores = 0;
    const core: OverlayfsCore = {
      ping: async () => coreInfo,
      overlayMount: async () => { calls.push("mount"); return { ok: true, method: "kernel" }; },
      overlayUnmount: async () => { calls.push("unmount"); return { ok: true }; },
      overlayCheckpoint: async (request) => {
        calls.push("checkpoint");
        await cp(request.upper, request.dest, { recursive: true });
        return { ok: true, files: 1, bytes: 1, skipped: 0 };
      },
      overlayRestore: async (request) => {
        calls.push("restore");
        restores += 1;
        if (options.busyRestore && restores === 1) throw new CoreRpcError(-32005, "overlay.restore requires no running jobs");
        if ((options.failRestoreOnce && restores === 1) || options.failRecovery) {
          await rm(request.upper, { recursive: true, force: true });
          await mkdir(request.upper, { recursive: true });
          await writeFile(path.join(request.upper, "partial.txt"), "partial");
          throw new Error("copy failed");
        }
        await rm(request.upper, { recursive: true, force: true });
        await mkdir(request.upper, { recursive: true });
        await cp(request.sourceUpper, request.upper, { recursive: true });
        return { ok: true, files: 1, bytes: 1, skipped: 0, method: "kernel" };
      },
    };
    return { core, calls };
  }
  it("create 持久化 activeLeafId；core restore 失败时用 backup 再走一次 restore", async () => {
    const { origin, sessionRoot, paths } = await rig();
    const { core, calls } = fakeCore({ failRestoreOnce: true });
    const backend = new OverlayfsBackend({ sessionRoot, originCwd: origin, core });
    const checkpoint = await backend.create("new", 1, { round: 1 }, "leaf-1");
    expect(checkpoint.activeLeafId).toBe("leaf-1");
    await expect(backend.restore(id)).rejects.toThrow(/copy failed/);
    expect(calls).toEqual(["mount", "checkpoint", "mount", "checkpoint", "restore", "restore"]);
    expect(await readFile(path.join(paths.upper, "current.txt"), "utf8")).toBe("current");
    await expect(readFile(path.join(paths.upper, "partial.txt"), "utf8")).rejects.toThrow();
    expect((await readdir(paths.stateRoot)).filter((entry) => entry.includes("restore-backup"))).toEqual([]);
  });
  it("core 以 running-job 拒绝时不动 upper，并删除 backup", async () => {
    const { origin, sessionRoot, paths } = await rig();
    const { core, calls } = fakeCore({ busyRestore: true });
    await expect(new OverlayfsBackend({ sessionRoot, originCwd: origin, core }).restore(id)).rejects.toThrow(/运行中的任务/);
    expect(calls).toEqual(["mount", "checkpoint", "restore"]);
    expect(await readFile(path.join(paths.upper, "current.txt"), "utf8")).toBe("current");
    expect((await readdir(paths.stateRoot)).filter((entry) => entry.includes("restore-backup"))).toEqual([]);
  });
  it("恢复也失败时保留 backup 供人工恢复，不删除可能仍挂载的 upper", async () => {
    const { origin, sessionRoot, paths } = await rig();
    const { core, calls } = fakeCore({ failRestoreOnce: true, failRecovery: true });
    await expect(new OverlayfsBackend({ sessionRoot, originCwd: origin, core }).restore(id))
      .rejects.toThrow(/backup kept/);
    expect(calls).toEqual(["mount", "checkpoint", "restore", "restore"]);
    expect(await readFile(path.join(paths.upper, "partial.txt"), "utf8")).toBe("partial");
    const backups = (await readdir(paths.stateRoot)).filter((entry) => entry.includes("restore-backup"));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(paths.stateRoot, backups[0]!, "current.txt"), "utf8")).toBe("current");
  });
  it("restore 成功用检查点重建 upper，并删除 backup", async () => {
    const { origin, sessionRoot, paths } = await rig();
    const { core, calls } = fakeCore();
    await new OverlayfsBackend({ sessionRoot, originCwd: origin, core }).restore(id);
    expect(calls).toEqual(["mount", "checkpoint", "restore"]);
    expect(await readFile(path.join(paths.upper, "old.txt"), "utf8")).toBe("old");
    await expect(readFile(path.join(paths.upper, "current.txt"), "utf8")).rejects.toThrow();
    expect((await readdir(paths.stateRoot)).filter((entry) => entry.includes("restore-backup"))).toEqual([]);
  });
});

describe("ManagedDiskBackend qcow2 换叶", () => {
  async function rig() {
    const root = await tempRoot("owc-qcow2-");
    const workspaceRoot = path.join(root, "ws");
    const mountPoint = path.join(root, "mnt");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(mountPoint, { recursive: true });
    const base = path.join(workspaceRoot, "base.qcow2");
    await writeFile(base, "base");
    await writeFile(path.join(workspaceRoot, "chain.json"), `${JSON.stringify({ active: { file: base, parentFile: null }, device: "/dev/nbd0", mountPoint, checkpoints: [] }, null, 2)}\n`);
    return { workspaceRoot, mountPoint, base };
  }
  function makeRunner(options: { failMount?: boolean } = {}) {
    const calls: string[] = [];
    let mounts = 0;
    const runner: CommandRunner = {
      async run(cmd, args) {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "qemu-img" && args[0] === "create") {
          const child = args[args.length - 1]!;
          await writeFile(child, "child");
          return { stdout: "", code: 0 };
        }
        if (cmd === "sudo" && args[0] === "mount") {
          mounts += 1;
          return { stdout: "", code: options.failMount && mounts === 1 ? 1 : 0 };
        }
        return { stdout: "", code: 0 };
      },
    };
    return { runner, calls };
  }
  it("换叶挂载失败时重连旧叶子、清掉 child，chain.json 不变", async () => {
    const { workspaceRoot, mountPoint, base } = await rig();
    const { runner, calls } = makeRunner({ failMount: true });
    const backend = new ManagedDiskBackend({ kind: "qcow2", workspaceRoot, mountPoint, runner });
    await expect(backend.create("cp", 1, undefined, "leaf-1")).rejects.toThrow(/mount failed/);
    expect(calls.filter((call) => call.includes("qemu-nbd -c")).length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toBe(`sudo mount /dev/nbd0 ${mountPoint}`);
    expect(await readFile(path.join(workspaceRoot, "chain.json"), "utf8")).toContain(`"file": "${base}"`);
    expect((await readdir(workspaceRoot)).sort()).toEqual(["base.qcow2", "chain.json"]);
  });
  it("成功换叶记录 activeLeafId 并把旧叶冻结为检查点载体", async () => {
    const { workspaceRoot, mountPoint, base } = await rig();
    const { runner } = makeRunner();
    const backend = new ManagedDiskBackend({ kind: "qcow2", workspaceRoot, mountPoint, runner });
    const checkpoint = await backend.create("cp", 2, { round: 1 }, "leaf-2");
    expect(checkpoint).toMatchObject({ activeLeafId: "leaf-2", messageCount: 2, ledger: { round: 1 } });
    const state = JSON.parse(await readFile(path.join(workspaceRoot, "chain.json"), "utf8")) as { active: { file: string; parentFile: string }; checkpoints: Array<{ id: string; file: string; activeLeafId: string }> };
    expect(state.active.file).not.toBe(base);
    expect(state.active.parentFile).toBe(base);
    expect(state.checkpoints).toMatchObject([{ id: checkpoint.id, file: base, activeLeafId: "leaf-2" }]);
    expect((await readdir(workspaceRoot)).some((entry) => entry === path.basename(state.active.file))).toBe(true);
  });
});

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined))));

/** snapshot routes 夹具：临时工作区 + sessions/events/pricing + buildServer（app 由 afterEach 关闭）。 */
async function routesApp(overrides: Partial<Pick<Parameters<typeof buildServer>[0], "resolveSnapshotBackend" | "core" | "agent">> = {}) {
  const { root, workspace } = await tempWorkspace("owc-snaproute-", { "a.txt": "one" });
  const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
  const events = new EventBus(), published: AppEvent[] = []; events.on("event", (event) => published.push(event));
  const app = await buildServer({
    core: {} as CoreClient, sessions, pricing, events, providers: new ProviderRegistry(),
    agent: { isRunning: () => false } as AgentRunner, ...overrides,
  });
  apps.push(app);
  return { app, sessions, workspace, published };
}

describe("snapshot routes", () => {
  it("capability 上报字段并落盘 meta；checkpoint 创建/列出/删除往返与事件", async () => {
    const { app, sessions, workspace, published } = await routesApp();
    const session = await sessions.create({ cwd: workspace });
    const capability = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/snapshot-capability` });
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toMatchObject({ backend: "git-shadow", costHint: "linear", requiresAdmin: false });
    expect((await sessions.get(session.id))?.snapshotBackend).toBe("git-shadow");
    const created = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "manual" } });
    expect(created.statusCode).toBe(201);
    const checkpoint = created.json<{ id: string; label: string }>();
    const listed = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/checkpoints` })).json();
    expect(listed).toMatchObject([{ id: checkpoint.id, label: "manual" }]); expect(listed).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}/checkpoints/${checkpoint.id}` })).statusCode).toBe(204);
    expect(published.some((event) => event.type === "checkpoint.deleted" && (event.payload as { id?: string }).id === checkpoint.id)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/checkpoints` })).json()).toEqual([]);
  });
  // B2：并发 POST /checkpoints 会撞 git index.lock / 丢 checkpoints.json 条目 —— per-session 快照锁
  it("并发 POST /checkpoints 串行化：一个 201 一个 409，条目不丢", async () => {
    const { app, sessions, workspace } = await routesApp();
    const session = await sessions.create({ cwd: workspace });
    const create = (label: string) => app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label } });
    const [first, second] = await Promise.all([create("c1"), create("c2")]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    // 非托管会话（git-shadow）如实描述冲突来源
    expect((first.statusCode === 409 ? first : second).json()).toMatchObject({ error: "A checkpoint operation is already in progress for this session" });
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/checkpoints` })).json()).toHaveLength(1);
    expect((await create("c3")).statusCode).toBe(201); // 锁在请求结束后释放
  });
  it("POST restore 回退消息后活动叶子重置，后续追加的活动路径完整", async () => {
    const { app, sessions, workspace } = await routesApp();
    const session = await sessions.create({ cwd: workspace });
    const early = [];
    for (let index = 0; index < 3; index++) early.push(await sessions.appendMessage(session.id, "user", [{ type: "text", text: `m${index}` }]));
    const created = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "cp" } });
    expect(created.statusCode).toBe(201);
    const checkpoint = created.json<{ id: string; messageCount: number }>();
    expect(checkpoint.messageCount).toBe(3);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "later" }]);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, payload: { confirm: true } })).statusCode).toBe(200);
    const afterRestore = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "after" }]);
    const detail = await sessions.get(session.id);
    expect(detail!.messages).toHaveLength(4);
    expect(detail!.activeLeafId).toBe(afterRestore.id);
    expect(activePathMessages(detail!.messages, detail!.activeLeafId).map((message) => message.id))
      .toEqual([...early.map((message) => message.id), afterRestore.id]);
  });
  it("restore 期间 shell/checkout 被 409 挡住，锁释放后恢复完成", async () => {
    let releaseRestore!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRestore = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const backend: SnapshotBackend = {
      name: "git-shadow",
      initialize: async () => undefined,
      async create() { throw new Error("unused"); },
      async list() { return []; },
      async diff() { return ""; },
      async restore() { markStarted(); await gate; },
      async delete() {},
      async capability() { return { backend: "git-shadow", costHint: "linear", requiresAdmin: false }; },
    };
    const { app, sessions, workspace } = await routesApp({ resolveSnapshotBackend: async () => backend });
    const session = await sessions.create({ cwd: workspace });
    const message = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "u" }]);
    const checkpoint = { id: SNAP_ID, label: "cp", createdAt: new Date().toISOString(), messageCount: 1, activeLeafId: message.id };
    backend.list = async () => [checkpoint];
    const restore = app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${SNAP_ID}/restore`, payload: { confirm: true } });
    await started;
    try {
      const shell = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/shell`, payload: { cmd: "echo x" } });
      expect(shell.statusCode).toBe(409);
      const checkout = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkout`, payload: { messageId: message.id } });
      expect(checkout.statusCode).toBe(409);
    } finally {
      releaseRestore();
    }
    expect((await restore).statusCode).toBe(200);
  });

  it("非 overlayfs/镜像盘后端回滚也要求关闭终端，409 后锁正常释放", async () => {
    const terminals = new Set<string>();
    const backend: SnapshotBackend = {
      name: "git-shadow",
      initialize: async () => undefined,
      async create() { throw new Error("unused"); },
      async list() { return []; },
      async diff() { return ""; },
      async restore() {},
      async delete() {},
      async capability() { return { backend: "git-shadow", costHint: "linear", requiresAdmin: false }; },
    };
    const { app, sessions, workspace } = await routesApp({
      resolveSnapshotBackend: async () => backend,
      core: { activeTerminalSessions: () => terminals } as CoreClient,
    });
    const session = await sessions.create({ cwd: workspace });
    const message = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "u" }]);
    backend.list = async () => [{ id: SNAP_ID, label: "cp", createdAt: new Date().toISOString(), messageCount: 1, activeLeafId: message.id }];
    terminals.add(session.id);
    const blocked = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${SNAP_ID}/restore`, payload: { confirm: true } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "snapshot_terminal_open" });
    terminals.clear();
    const allowed = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${SNAP_ID}/restore`, payload: { confirm: true } });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it("损坏尾行导致 checkpoint.messageCount 大于有效消息数时仍可回滚", async () => {
    const backend: SnapshotBackend = {
      name: "git-shadow",
      initialize: async () => undefined,
      async create() { throw new Error("unused"); },
      async list() { return []; },
      async diff() { return ""; },
      async restore() {},
      async delete() {},
      async capability() { return { backend: "git-shadow", costHint: "linear", requiresAdmin: false }; },
    };
    const { app, sessions, workspace } = await routesApp({ resolveSnapshotBackend: async () => backend });
    const session = await sessions.create({ cwd: workspace });
    const message = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "u" }]);
    await appendFile(path.join(sessions.contextRoot(session.id), "messages.jsonl"), "{broken\n", "utf8");
    const checkpoint = { id: SNAP_ID, label: "cp", createdAt: new Date().toISOString(), messageCount: 2, activeLeafId: message.id };
    backend.list = async () => [checkpoint];
    const res = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${SNAP_ID}/restore`, payload: { confirm: true } });
    expect(res.statusCode, res.body).toBe(200);
    const detail = await sessions.get(session.id);
    expect(detail?.messages.map((item) => item.id)).toEqual([message.id]);
    expect(detail?.activeLeafId).toBe(message.id);
  });

  it("分支回滚恢复检查点时的 activeLeafId，而不是物理最后一条消息", async () => {
    const { app, sessions, workspace } = await routesApp();
    const session = await sessions.create({ cwd: workspace });
    const u1 = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "u1" }]);
    const a1 = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "a1" }]);
    const u2 = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "u2" }]);
    const a2 = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "a2" }]);
    // 检查点创建时活动叶子是 a1（物理最后一条却是另一支的 a2）。
    await sessions.setActiveLeaf(session.id, a1.id);
    const created = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "branch point" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ activeLeafId: a1.id, messageCount: 4 });
    const checkpoint = created.json<{ id: string }>();
    // 从 a1 续写 u3，然后再回滚：旧实现会把活动叶子设成物理末条 a2。
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "u3" }]);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, payload: { confirm: true } })).statusCode).toBe(200);
    const detail = await sessions.get(session.id);
    expect(detail!.messages.map((message) => message.id)).toEqual([u1.id, a1.id, u2.id, a2.id]);
    expect(detail!.activeLeafId).toBe(a1.id);
    const afterRestore = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "after" }]);
    expect(afterRestore.parentId).toBe(a1.id);
  });

  it("回滚预检不合法历史/终端占用：返回 409 且不调用后端 restore", async () => {
    let terminal = false;
    let restoreCalls = 0;
    let checkpoint = { id: SNAP_ID, label: "cp", createdAt: new Date().toISOString(), messageCount: 1, activeLeafId: "missing-leaf" };
    const backend: SnapshotBackend = {
      name: "overlayfs", initialize: async () => undefined, async create() { throw new Error("unused"); },
      async list() { return [checkpoint]; }, async diff() { return ""; }, async restore() { restoreCalls += 1; }, async delete() {},
      async capability() { return { backend: "overlayfs", costHint: "linear", requiresAdmin: false }; },
    };
    const core = { activeTerminalSessions: () => terminal ? new Set([sessionId]) : new Set<string>() } as unknown as CoreClient;
    let sessionId = "";
    const { app, sessions, workspace } = await routesApp({ resolveSnapshotBackend: async () => backend, core });
    const session = await sessions.create({ cwd: workspace });
    sessionId = session.id;
    const message = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "m" }]);
    checkpoint = { ...checkpoint, activeLeafId: message.id };
    // 先让叶子不匹配：预检必须在动后端之前失败。
    const bad = { ...checkpoint, activeLeafId: "missing-leaf" };
    const list = backend.list;
    backend.list = async () => [bad];
    let res = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${SNAP_ID}/restore`, payload: { confirm: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "checkpoint_history_mismatch" });
    expect(restoreCalls).toBe(0);
    // 叶子合法但终端打开：同样不动后端。
    backend.list = list;
    terminal = true;
    res = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${SNAP_ID}/restore`, payload: { confirm: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "snapshot_terminal_open" });
    expect(restoreCalls).toBe(0);
  });

  it("所有后端回滚前都先回收持久 shell，再调用 backend.restore", async () => {
    const order: string[] = [];
    const checkpoint = { id: SNAP_ID, label: "cp", createdAt: new Date().toISOString(), messageCount: 0 };
    const backend: SnapshotBackend = {
      name: "git-shadow", initialize: async () => undefined, async create() { throw new Error("unused"); },
      async list() { return [checkpoint]; }, async diff() { return ""; }, async restore() { order.push("restore"); }, async delete() {},
      async capability() { return { backend: "git-shadow", costHint: "linear", requiresAdmin: false }; },
    };
    const agent = { isRunning: () => false, disposePersistentShells: async () => { order.push("dispose"); } } as unknown as AgentRunner;
    const { app, sessions, workspace } = await routesApp({ resolveSnapshotBackend: async () => backend, agent });
    const session = await sessions.create({ cwd: workspace });
    const res = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${SNAP_ID}/restore`, payload: { confirm: true } });
    expect(res.statusCode).toBe(200);
    expect(order).toEqual(["dispose", "restore"]);
  });

  it("qcow2-chain 创建前回收持久 shell；终端打开时 409 且不回收", async () => {
    let terminal = true;
    const order: string[] = [];
    const backend: SnapshotBackend = {
      name: "qcow2-chain",
      initialize: async () => undefined,
      async create(label, messageCount) { order.push("create"); return { id: SNAP_ID, label, createdAt: new Date().toISOString(), messageCount }; },
      async list() { return []; }, async diff() { return ""; }, async restore() {}, async delete() {},
      async capability() { return { backend: "qcow2-chain", costHint: "instant", requiresAdmin: true }; },
    };
    let sessionId = "";
    const core = { activeTerminalSessions: () => terminal ? new Set([sessionId]) : new Set<string>() } as unknown as CoreClient;
    const agent = { isRunning: () => false, disposePersistentShells: async () => { order.push("dispose"); } } as unknown as AgentRunner;
    const { app, sessions, workspace } = await routesApp({ resolveSnapshotBackend: async () => backend, core, agent });
    const session = await sessions.create({ cwd: workspace });
    sessionId = session.id;
    let res = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "cp" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "snapshot_terminal_open" });
    expect(order).toEqual([]);
    terminal = false;
    res = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "cp" } });
    expect(res.statusCode).toBe(201);
    expect(order).toEqual(["dispose", "create"]);
  });
  it("镜像盘创建前发现未关闭的 PTY 仍占用时 409；悬挂 activeLeafId 收敛为物理末条", async () => {
    let ptyOpen = true;
    const order: string[] = [];
    const backend: SnapshotBackend = {
      name: "qcow2-chain",
      initialize: async () => undefined,
      async create(label, messageCount, _ledger, activeLeafId) {
        order.push("create");
        return { id: SNAP_ID, label, createdAt: new Date().toISOString(), messageCount, ...(activeLeafId ? { activeLeafId } : {}) };
      },
      async list() { return []; }, async diff() { return ""; }, async restore() {}, async delete() {},
      async capability() { return { backend: "qcow2-chain", costHint: "instant", requiresAdmin: true }; },
    };
    let sessionId = "";
    const core = {
      activeTerminalSessions: () => new Set<string>(),
      activePtySessions: () => ptyOpen ? new Set([sessionId]) : new Set<string>(),
    } as unknown as CoreClient;
    const agent = { isRunning: () => false, disposePersistentShells: async () => { order.push("dispose"); } } as unknown as AgentRunner;
    const { app, sessions, workspace } = await routesApp({ resolveSnapshotBackend: async () => backend, core, agent });
    const session = await sessions.create({ cwd: workspace });
    sessionId = session.id;
    const message = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "u" }]);
    await sessions.setActiveLeaf(session.id, "missing-leaf");
    let res = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "cp" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "snapshot_pty_open" });
    expect(order).toEqual(["dispose"]);
    ptyOpen = false;
    res = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "cp" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ activeLeafId: message.id });
    expect(order).toEqual(["dispose", "dispose", "create"]);
  });
  it("后端失败：POST /checkpoints 返回 500；回退不存在的检查点返回 404", async () => {
    const noop = async () => undefined;
    const backend: SnapshotBackend = {
      name: "stub", initialize: noop, async create() { throw new Error("backend exploded"); }, async list() { return []; }, async diff() { return ""; }, restore: noop, delete: noop,
      async capability() { return { backend: "stub", costHint: "linear", requiresAdmin: false }; },
    } as unknown as SnapshotBackend;
    const { app, sessions, workspace } = await routesApp({ resolveSnapshotBackend: async () => backend });
    const session = await sessions.create({ cwd: workspace });
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "boom" } })).statusCode).toBe(500);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${SNAP_ID}/restore`, payload: { confirm: true } })).statusCode).toBe(404);
  });
});

/** 影子快照夹具：临时 root + workspace/session 目录。 */
async function shadowRig(prefix: string) {
  const { workspace, root } = await tempWorkspace(prefix);
  return { workspace, session: path.join(root, "session") };
}

describe("GitShadowSnapshots", () => {
  it("空树检查点回退清空工作区；跟踪/未跟踪文件往返 + diff 供 hunk 解析 + ledger 一致", async () => {
    const { workspace, session } = await shadowRig("owc-shadow-");
    const snapshots = new GitShadowSnapshots(session, workspace);
    const empty = await snapshots.create("empty baseline", 0, { round: 0 });
    await writeFiles(workspace, { "later.txt": "added after the checkpoint" });
    await snapshots.restore(empty.id);
    await expect(readFile(path.join(workspace, "later.txt"), "utf8")).rejects.toThrow();
    await writeFiles(workspace, { "a.txt": "one", "untracked.txt": "keep", ".gitignore": "*.cache\n", "saved.cache": "saved" });
    expect(await snapshots.capability()).toMatchObject({ backend: "git-shadow", requiresAdmin: false });
    const checkpoint = await snapshots.create("before edit", 2, { round: 1 }, "leaf-1");
    await writeFiles(workspace, { "a.txt": "two", "new.txt": "new", "new.cache": "ignored", "saved.cache": "changed" });
    // diff 供 Web diff 视图做 hunk 解析：文件头 + hunk 头 + 完整增删行
    const diffText = await snapshots.diff(checkpoint.id);
    expect(diffText).toMatch(/diff --git a\/a\.txt b\/a\.txt[\s\S]*@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[\s\S]*-one[\s\S]*\+two/);
    await snapshots.restore(checkpoint.id);
    expect((await snapshots.list()).find((item) => item.id === checkpoint.id)).toMatchObject({ activeLeafId: "leaf-1", ledger: { round: 1 } });
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe("keep");
    expect(await readFile(path.join(workspace, "saved.cache"), "utf8")).toBe("saved");
    await expect(readFile(path.join(workspace, "new.cache"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace, "new.txt"), "utf8")).rejects.toThrow();
  });
  // B9：`add -u` 会把「已被跟踪、检查点之后才加入 deny」的路径改动也暂存进快照。
  it("检查点之后加入 deny 的已跟踪文件改动不进快照", async () => {
    const { workspace, session } = await shadowRig("owc-shadow-deny-");
    await writeFiles(workspace, { ".env": "SECRET=original", "app.txt": "v1" });
    // 首个检查点：.env 尚未被 deny（git-shadow 默认排除项不含 .env）→ 正常跟踪进快照
    const first = await new GitShadowSnapshots(session, workspace).create("baseline", 1);
    expect(await gitShow(session, workspace, `${first.id}:.env`)).toBe("SECRET=original");
    await writeFiles(workspace, { ".env": "SECRET=changed", "app.txt": "v2" });
    // 此时 .env 加入会话 deny：add -u 的暂存必须在提交前撤出该路径
    const guarded = new GitShadowSnapshots(session, workspace, { denyPaths: [path.join(workspace, ".env")] });
    const second = await guarded.create("guarded", 2);
    expect(await gitShow(session, workspace, `${second.id}:.env`)).toBe("SECRET=original");
    expect(await gitShow(session, workspace, `${second.id}:app.txt`)).toBe("v2");
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=changed"); // 工作区改动仍在（只是没进快照）
  });
});

/** 读影子仓库里某个检查点版本的路径内容（git show <sha>:<path>）。 */
async function gitShow(sessionRoot: string, workspace: string, spec: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--git-dir", path.join(sessionRoot, "shadow.git"), "--work-tree", workspace, "show", spec]);
  return stdout;
}
