import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import {
  CoreRpcError,
  type CoreInfo,
  type OverlayCheckpointRequest,
  type OverlayMountRequest,
  type OverlayRestoreRequest,
  type OverlayUnmountRequest,
} from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { getSnapshotBackend } from "../src/snapshots/index.js";
import { ManagedWorkspaceManager, type ManagedWorkspaceLike } from "../src/snapshots/managed-disk.js";
import {
  OVERLAY_RESTORE_BUSY_CODE,
  OverlayfsBackend,
  overlayfsPaths,
  type OverlayfsCore,
} from "../src/snapshots/overlayfs.js";

import { FAKE_CORE_INFO, makeFakeCore } from "./helpers/fake-core.js";
import { tableRunner } from "./helpers/recording-runner.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

function overlayInfo(supported: boolean, method: "kernel" | "fuse" = "fuse"): CoreInfo {
  return {
    ...FAKE_CORE_INFO,
    platform: "linux",
    features: { ...FAKE_CORE_INFO.features, overlay: { supported, fuseOverlayfs: method === "fuse", kernelMount: method === "kernel" } },
  };
}

/** fake core overlay.*：记录调用、幂等建目录；emulateMergedView 时把 lower 复制进 merged 模拟挂载视图。 */
function makeFakeOverlayCore(options: { supported?: boolean; method?: "kernel" | "fuse"; restoreError?: Error; emulateMergedView?: boolean } = {}) {
  const method = options.method ?? "fuse";
  const calls: Array<{ method: string; request: unknown }> = [];
  const core: OverlayfsCore = {
    ping: async () => overlayInfo(options.supported ?? true, method),
    overlayMount: async (request: OverlayMountRequest) => {
      calls.push({ method: "overlay.mount", request });
      await mkdir(request.upper, { recursive: true });
      await mkdir(request.work, { recursive: true });
      await mkdir(request.merged, { recursive: true });
      if (options.emulateMergedView) await cp(request.lower, request.merged, { recursive: true });
      return { ok: true as const, method };
    },
    overlayCheckpoint: async (request: OverlayCheckpointRequest) => {
      calls.push({ method: "overlay.checkpoint", request });
      await cp(request.upper, request.dest, { recursive: true });
      return { ok: true as const, files: 1, bytes: 1, skipped: 0 };
    },
    overlayRestore: async (request: OverlayRestoreRequest) => {
      calls.push({ method: "overlay.restore", request });
      if (options.restoreError) throw options.restoreError;
      return { ok: true as const, files: 0, bytes: 0, skipped: 0, method };
    },
    overlayUnmount: async (request: OverlayUnmountRequest) => {
      calls.push({ method: "overlay.unmount", request });
      return { ok: true as const };
    },
  };
  return { core, calls };
}

describe("OverlayfsBackend", () => {
  it("create/list/delete：overlay.checkpoint 落 checkpoints/<id>，元数据在 stateRoot/checkpoints.json", async () => {
    const root = await tempRoot("owc-ovfs-");
    const sessionRoot = path.join(root, "sess");
    const origin = path.join(root, "origin");
    await mkdir(origin, { recursive: true });
    const paths = overlayfsPaths(sessionRoot);
    const { core, calls } = makeFakeOverlayCore();
    const backend = new OverlayfsBackend({ sessionRoot, originCwd: origin, core });

    const checkpoint = await backend.create("label", 3, { round: 1 });
    const mount = calls.find((call) => call.method === "overlay.mount");
    expect(mount?.request).toMatchObject({
      stateRoot: paths.stateRoot,
      lower: path.resolve(origin),
      upper: paths.upper,
      work: paths.work,
      merged: paths.merged,
    });
    const copy = calls.find((call) => call.method === "overlay.checkpoint");
    expect(copy?.request).toMatchObject({ stateRoot: paths.stateRoot, upper: paths.upper, dest: path.join(paths.checkpointsDir, checkpoint.id) });

    const listed = await backend.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: checkpoint.id, label: "label", messageCount: 3, ledger: { round: 1 } });
    const raw = JSON.parse(await readFile(paths.checkpointsFile, "utf8")) as Array<{ id: string }>;
    expect(raw.map((item) => item.id)).toEqual([checkpoint.id]);

    await backend.delete(checkpoint.id);
    expect(await backend.list()).toHaveLength(0);
  });

  it("diff：对比检查点 upper 副本与当前 upper 层，产出 A/M/D 清单（含 .wh. 删除标记）", async () => {
    const root = await tempRoot("owc-ovfs-diff-");
    const sessionRoot = path.join(root, "sess");
    const origin = path.join(root, "origin");
    await mkdir(origin, { recursive: true });
    const paths = overlayfsPaths(sessionRoot);
    const id = "snap-1-abcdef";
    // 检查点时刻的 upper：a.txt 旧内容
    await mkdir(path.join(paths.checkpointsDir, id), { recursive: true });
    await writeFile(path.join(paths.checkpointsDir, id, "a.txt"), "old", "utf8");
    // 当前 upper：a.txt 改动、b.txt 新增、gone.txt 删除标记
    await mkdir(paths.upper, { recursive: true });
    await writeFile(path.join(paths.upper, "a.txt"), "new-content", "utf8");
    await writeFile(path.join(paths.upper, "b.txt"), "added", "utf8");
    await writeFile(path.join(paths.upper, ".wh.gone.txt"), "", "utf8");
    await mkdir(paths.stateRoot, { recursive: true });
    await writeFile(paths.checkpointsFile, `${JSON.stringify([{ id, label: "l", createdAt: new Date().toISOString(), messageCount: 1 }])}\n`, "utf8");

    const { core } = makeFakeOverlayCore();
    const backend = new OverlayfsBackend({ sessionRoot, originCwd: origin, core });
    const diff = await backend.diff(id);
    expect(diff).toContain("新增 1，修改 1，删除 1");
    expect(diff).toContain("A b.txt");
    expect(diff).toContain("M a.txt");
    expect(diff).toContain("D gone.txt");
  });

  it("diff/restore/delete 拒绝未知检查点与非法 id", async () => {
    const root = await tempRoot("owc-ovfs-invalid-");
    const sessionRoot = path.join(root, "sess");
    const { core } = makeFakeOverlayCore();
    const backend = new OverlayfsBackend({ sessionRoot, originCwd: root, core });
    await expect(backend.diff("snap-1-abcdef")).rejects.toThrow("Checkpoint not found");
    await expect(backend.restore("../etc")).rejects.toThrow("Invalid checkpoint ID");
    await expect(backend.delete("snap-1-abcdef")).rejects.toThrow("Checkpoint not found");
  });

  it("restore：overlay.restore 以检查点副本为 sourceUpper；-32005 映射为可读错误", async () => {
    const root = await tempRoot("owc-ovfs-restore-");
    const sessionRoot = path.join(root, "sess");
    const origin = path.join(root, "origin");
    await mkdir(origin, { recursive: true });
    const { core, calls } = makeFakeOverlayCore();
    const backend = new OverlayfsBackend({ sessionRoot, originCwd: origin, core });
    const checkpoint = await backend.create("label", 1);

    calls.length = 0;
    await backend.restore(checkpoint.id);
    const restore = calls.find((call) => call.method === "overlay.restore");
    const paths = overlayfsPaths(sessionRoot);
    expect(restore?.request).toMatchObject({
      stateRoot: paths.stateRoot,
      lower: path.resolve(origin),
      upper: paths.upper,
      work: paths.work,
      merged: paths.merged,
      sourceUpper: path.join(paths.checkpointsDir, checkpoint.id),
    });

    const busy = makeFakeOverlayCore({ restoreError: new CoreRpcError(OVERLAY_RESTORE_BUSY_CODE, "jobs running") });
    const busyBackend = new OverlayfsBackend({ sessionRoot, originCwd: origin, core: busy.core });
    await expect(busyBackend.restore(checkpoint.id)).rejects.toThrow("存在运行中的任务，请先停止再回滚");
  });

  it("capability：linear 成本、不需管理员、detail 说明只读源目录与挂载方式", async () => {
    const root = await tempRoot("owc-ovfs-cap-");
    const sessionRoot = path.join(root, "sess");
    const kernel = makeFakeOverlayCore({ method: "kernel" });
    const capability = await new OverlayfsBackend({ sessionRoot, originCwd: root, core: kernel.core }).capability();
    expect(capability).toMatchObject({ backend: "overlayfs", costHint: "linear", requiresAdmin: false });
    expect(capability.detail).toContain("内核 overlayfs");
    expect(capability.detail).toContain("源目录只读，需手动同步回源");
  });

  it("旧 core 无 overlay.* 方法时报不可用", async () => {
    const root = await tempRoot("owc-ovfs-oldcore-");
    const core: OverlayfsCore = { ping: async () => overlayInfo(false) };
    const backend = new OverlayfsBackend({ sessionRoot: path.join(root, "sess"), originCwd: root, core });
    await expect(backend.create("l", 0)).rejects.toThrow("不支持 overlay");
  });
});

describe("getSnapshotBackend overlayfs", () => {
  it("meta 预设 overlayfs 时按托管语义构造：lower 取 originCwd 而非 cwd（merged）", async () => {
    const root = await tempRoot("owc-ovfs-resolve-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const origin = path.join(root, "origin");
    const merged = path.join(root, "merged");
    await mkdir(origin, { recursive: true });
    await mkdir(merged, { recursive: true });
    const { core, calls } = makeFakeOverlayCore();
    const session = await sessions.create({
      cwd: merged,
      provider: "p",
      model: "m",
      workspace: { mode: "managed", backend: "overlayfs", originCwd: origin, image: path.join(root, "sessions", "x", "overlay"), mountPoint: merged },
      snapshotBackend: "overlayfs",
    });
    const backend = await getSnapshotBackend(sessions, session, { core });
    expect(backend.name).toBe("overlayfs");
    await backend.create("l", 0);
    const mount = calls.find((call) => call.method === "overlay.mount");
    expect(mount?.request).toMatchObject({ lower: path.resolve(origin) });
  });

  it("存量直接会话探测到 overlayfs 能力时回落 git-shadow（不中途切换 cwd）", async () => {
    const root = await tempRoot("owc-ovfs-legacy-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const workspace = path.join(root, "ws");
    await mkdir(workspace, { recursive: true });
    const session = await sessions.create({ cwd: workspace, provider: "p", model: "m" });
    const { core } = makeFakeOverlayCore();
    // platform 注入 linux：Windows 开发机上 stat/findmnt 不存在自然不命中，core 能力命中 overlayfs
    const backend = await getSnapshotBackend(sessions, session, { core, platform: "linux" });
    expect(backend.name).toBe("git-shadow");
    expect((await sessions.get(session.id))?.snapshotBackend).toBe("git-shadow");
  });
});

describe("ManagedWorkspaceManager overlayfs", () => {
  async function fixture(options: { emulateMergedView?: boolean } = { emulateMergedView: true }) {
    const root = await tempRoot("owc-ovmanager-");
    const dataDir = path.join(root, "data");
    const origin = path.join(root, "origin");
    await mkdir(origin, { recursive: true });
    await writeFile(path.join(origin, "a.txt"), "hello", "utf8");
    const fake = makeFakeOverlayCore({ emulateMergedView: options.emulateMergedView ?? true });
    const manager = new ManagedWorkspaceManager({ dataDir, core: fake.core, platform: "linux", runner: tableRunner({}).runner });
    return { root, dataDir, origin, manager, calls: fake.calls };
  }

  it("provision：overlay.mount 挂 merged 视图，同步基线 sidecar 落 stateRoot", async () => {
    const { dataDir, origin, manager, calls } = await fixture();
    const result = await manager.provision({ sessionId: "sess-1", originCwd: origin, backend: "overlayfs" });
    const paths = overlayfsPaths(path.join(dataDir, "sessions", "sess-1"));
    expect(result).toEqual({ backend: "overlayfs", image: paths.stateRoot, mountPoint: paths.merged });
    expect(calls[0]?.method).toBe("overlay.mount");
    expect(calls[0]?.request).toMatchObject({ stateRoot: paths.stateRoot, lower: path.resolve(origin), merged: paths.merged });
    const baseline = JSON.parse(await readFile(path.join(paths.stateRoot, "sync-baseline.json"), "utf8")) as { sessionId: string; entries: Record<string, unknown> };
    expect(baseline.sessionId).toBe("sess-1");
    expect(Object.keys(baseline.entries)).toContain("a.txt");
  });

  it("previewSync：merged 视图新增文件计入回源预览", async () => {
    const { dataDir, origin, manager } = await fixture();
    const provisioned = await manager.provision({ sessionId: "sess-1", originCwd: origin, backend: "overlayfs" });
    const workspace = { mode: "managed" as const, backend: "overlayfs" as const, originCwd: path.resolve(origin), image: provisioned.image, mountPoint: provisioned.mountPoint };
    await writeFile(path.join(provisioned.mountPoint, "b.txt"), "new in merged", "utf8");
    const preview = await manager.previewSync({ id: "sess-1", workspace });
    expect(preview.summary.create).toBe(1);
    expect(preview.changes.find((change) => change.path === "b.txt")?.action).toBe("create");
    // 派生路径校验：篡改 meta mountPoint 必须被拒绝
    await expect(manager.previewSync({ id: "sess-1", workspace: { ...workspace, mountPoint: path.join(dataDir, "elsewhere") } })).rejects.toThrow("does not match");
  });

  it("teardown：overlay.unmount 后删除 stateRoot", async () => {
    const { dataDir, origin, manager, calls } = await fixture();
    const provisioned = await manager.provision({ sessionId: "sess-1", originCwd: origin, backend: "overlayfs" });
    const workspace = { mode: "managed" as const, backend: "overlayfs" as const, originCwd: path.resolve(origin), image: provisioned.image, mountPoint: provisioned.mountPoint };
    calls.length = 0;
    await manager.teardown({ id: "sess-1", workspace });
    expect(calls.map((call) => call.method)).toEqual(["overlay.unmount"]);
    await expect(readFile(path.join(dataDir, "sessions", "sess-1", "overlay", "checkpoints.json"), "utf8")).rejects.toThrow();
  });

  it("sweepOrphans：清理 meta 已缺失的 overlay 残留（卸载 + 删 stateRoot）", async () => {
    const { dataDir, manager, calls } = await fixture();
    const paths = overlayfsPaths(path.join(dataDir, "sessions", "orphan"));
    await mkdir(paths.merged, { recursive: true });
    await manager.sweepOrphans();
    expect(calls.some((call) => call.method === "overlay.unmount")).toBe(true);
    await expect(readFile(path.join(paths.stateRoot, "checkpoints.json"), "utf8")).rejects.toThrow();
  });
});

describe("POST /api/sessions overlayfs 自动升级", () => {
  async function fixture(supported: boolean) {
    const root = await tempRoot("owc-ovroute-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace, { recursive: true });
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* () {
      yield { type: "done", stopReason: "end_turn" };
    }));
    const events = new EventBus();
    const agent = { isRunning: () => false } as AgentRunner;
    const core = makeFakeCore({ ping: async () => overlayInfo(supported) });
    const provisionCalls: Array<{ sessionId: string; originCwd: string; backend: string }> = [];
    const managed: ManagedWorkspaceLike = {
      capability: async () => ({ platform: "linux", backends: [] }),
      provision: async (input) => {
        provisionCalls.push(input);
        const paths = overlayfsPaths(path.join(root, "sessions", input.sessionId));
        await mkdir(paths.merged, { recursive: true });
        return { backend: "overlayfs" as const, image: paths.stateRoot, mountPoint: paths.merged };
      },
      previewSync: async () => { throw new Error("not implemented"); },
      applySync: async () => { throw new Error("not implemented"); },
      teardown: async () => { /* no-op */ },
    };
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, managed, platform: "linux" });
    return { root, workspace, sessions, app, provisionCalls };
  }

  it("core 支持 overlay 时：cwd=merged、托管 meta 落盘、快照后端预设 overlayfs", async () => {
    const { workspace, sessions, app, provisionCalls } = await fixture(true);
    try {
      const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: workspace, provider: "test-stub", model: "m" } });
      expect(response.statusCode).toBe(201);
      const body = response.json<{ id: string; cwd: string; snapshotBackend?: string; workspace?: { mode: string; backend: string; originCwd: string; mountPoint: string } }>();
      expect(provisionCalls).toHaveLength(1);
      expect(provisionCalls[0]).toMatchObject({ backend: "overlayfs", originCwd: workspace });
      const expectedMerged = overlayfsPaths(sessions.contextRoot(body.id)).merged;
      expect(body.cwd).toBe(expectedMerged);
      expect(body.snapshotBackend).toBe("overlayfs");
      expect(body.workspace).toMatchObject({ mode: "managed", backend: "overlayfs", originCwd: path.resolve(workspace), mountPoint: expectedMerged });
      const stored = await sessions.get(body.id);
      expect(stored?.snapshotBackend).toBe("overlayfs");
      expect(stored?.workspace?.backend).toBe("overlayfs");
    } finally {
      await app.close();
    }
  });

  it("core 不支持 overlay 时：静默回落直接模式（cwd 原样、无托管 meta）", async () => {
    const { workspace, app, provisionCalls } = await fixture(false);
    try {
      const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: workspace, provider: "test-stub", model: "m" } });
      expect(response.statusCode).toBe(201);
      const body = response.json<{ cwd: string; workspace?: unknown }>();
      expect(provisionCalls).toHaveLength(0);
      expect(body.cwd).toBe(path.resolve(workspace));
      expect(body.workspace).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
