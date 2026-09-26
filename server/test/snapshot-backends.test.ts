import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as treeDiffModule from "../src/snapshots/tree-diff.js";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient, CoreInfo } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { activePathMessages } from "../src/sessions/session-tree.js";
import { writeCheckpoints, type SnapshotBackend } from "../src/snapshots/backend.js";
import { BtrfsBackend } from "../src/snapshots/btrfs.js";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";
import { probeSnapshotBackend, probeSnapshotBackendByName, type CommandRunner, type SnapshotProbeDeps } from "../src/snapshots/probe.js";
import type { OverlayfsCore } from "../src/snapshots/overlayfs.js";
import { ZfsBackend } from "../src/snapshots/zfs.js";
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
    const checkpoint = await backend.create("label", 3, { round: 1 });
    expect(recorded.calls[0]).toEqual({ cmd: "btrfs", args: ["subvolume", "snapshot", "-r", workspace, path.join(snapRoot, checkpoint.id)] });
    expect(await backend.list()).toMatchObject([{ id: checkpoint.id, label: "label", messageCount: 3, ledger: { round: 1 } }]);
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
    const checkpoint = await backend.create("label", 2);
    expect(recorded.calls[0]).toEqual({ cmd: "zfs", args: ["snapshot", `tank/ws@${checkpoint.id}`] });
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

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined))));

/** snapshot routes 夹具：临时工作区 + sessions/events/pricing + buildServer（app 由 afterEach 关闭）。 */
async function routesApp(overrides: Partial<Pick<Parameters<typeof buildServer>[0], "resolveSnapshotBackend">> = {}) {
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
    const checkpoint = await snapshots.create("before edit", 2, { round: 1 });
    await writeFiles(workspace, { "a.txt": "two", "new.txt": "new", "new.cache": "ignored", "saved.cache": "changed" });
    // diff 供 Web diff 视图做 hunk 解析：文件头 + hunk 头 + 完整增删行
    const diffText = await snapshots.diff(checkpoint.id);
    expect(diffText).toMatch(/diff --git a\/a\.txt b\/a\.txt[\s\S]*@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[\s\S]*-one[\s\S]*\+two/);
    await snapshots.restore(checkpoint.id);
    expect((await snapshots.list()).find((item) => item.id === checkpoint.id)?.ledger).toEqual({ round: 1 });
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
