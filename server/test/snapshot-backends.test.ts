import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { writeCheckpoints } from "../src/snapshots/backend.js";
import { BtrfsBackend } from "../src/snapshots/btrfs.js";
import { probeSnapshotBackend, type CommandRunner } from "../src/snapshots/probe.js";
import type { OverlayfsCore } from "../src/snapshots/overlayfs.js";
import type { CoreInfo } from "../src/core-client.js";
import { ZfsBackend } from "../src/snapshots/zfs.js";

import { FAKE_CORE_INFO } from "./helpers/fake-core.js";
import { recordingRunner, tableRunner } from "./helpers/recording-runner.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** fake core：ping 按参数上报 features.overlay；linux 平台。 */
function overlayCore(supported: boolean): OverlayfsCore {
  return {
    ping: async () => ({
      ...FAKE_CORE_INFO,
      platform: "linux",
      features: { ...FAKE_CORE_INFO.features, overlay: { supported, fuseOverlayfs: true, kernelMount: false } },
    }) as CoreInfo,
  };
}

describe("probeSnapshotBackend", () => {
  it("linux: btrfs 命中", async () => {
    const { runner } = tableRunner({
      "stat -f -c %T /data/ws": { stdout: "btrfs\n", code: 0 },
      "btrfs subvolume show /data/ws": { code: 0 },
    });
    const backend = await probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux" });
    expect(backend.name).toBe("btrfs");
  });

  it("linux: btrfs 不命中时 zfs 命中", async () => {
    const { runner } = tableRunner({
      "stat -f -c %T /data/ws": { stdout: "ext4\n", code: 0 },
      "findmnt -n -o FSTYPE --target /data/ws": { stdout: "zfs\n", code: 0 },
      "findmnt -n -o SOURCE --target /data/ws": { stdout: "tank/ws\n", code: 0 },
      "zfs list -H -o name tank/ws": { stdout: "tank/ws\n", code: 0 },
      "zfs list -H -o mountpoint tank/ws": { stdout: "/data/ws\n", code: 0 },
    });
    const backend = await probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux" });
    expect(backend.name).toBe("zfs");
  });

  it("linux: 全部不命中回落 git-shadow", async () => {
    const { runner } = tableRunner({});
    const backend = await probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux" });
    expect(backend.name).toBe("git-shadow");
  });

  it("win32: ReFS 命中", async () => {
    const { runner } = tableRunner({
      "powershell -NoProfile -Command (Get-Volume -DriveLetter C).FileSystem -eq 'ReFS'": { stdout: "True\r\n", code: 0 },
    });
    const backend = await probeSnapshotBackend("C:\\owc\\sess", "C:\\data\\ws", { runner, platform: "win32" });
    expect(backend.name).toBe("refs");
  });

  it("win32: 非 ReFS 回落 git-shadow", async () => {
    const { runner } = tableRunner({
      "powershell -NoProfile -Command (Get-Volume -DriveLetter C).FileSystem -eq 'ReFS'": { stdout: "False\r\n", code: 0 },
    });
    const backend = await probeSnapshotBackend("C:\\owc\\sess", "C:\\data\\ws", { runner, platform: "win32" });
    expect(backend.name).toBe("git-shadow");
  });

  it("win32: sessionRoot 与 workspace 不同盘符回落 git-shadow", async () => {
    const { runner, calls } = tableRunner({});
    const backend = await probeSnapshotBackend("D:\\owc\\sess", "C:\\data\\ws", { runner, platform: "win32" });
    expect(backend.name).toBe("git-shadow");
    expect(calls).toHaveLength(0);
  });

  it("linux: btrfs/zfs 不命中且 core 支持 overlay 时命中 overlayfs", async () => {
    const { runner } = tableRunner({});
    const backend = await probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux", core: overlayCore(true) });
    expect(backend.name).toBe("overlayfs");
  });

  it("linux: btrfs 命中优先于 overlayfs（探测链位置）", async () => {
    const { runner } = tableRunner({
      "stat -f -c %T /data/ws": { stdout: "btrfs\n", code: 0 },
      "btrfs subvolume show /data/ws": { code: 0 },
    });
    const backend = await probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux", core: overlayCore(true) });
    expect(backend.name).toBe("btrfs");
  });

  it("linux: core 不支持 overlay 或未注入 core 时回落 git-shadow", async () => {
    const { runner } = tableRunner({});
    await expect(probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux", core: overlayCore(false) })).resolves.toMatchObject({ name: "git-shadow" });
    await expect(probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux" })).resolves.toMatchObject({ name: "git-shadow" });
  });

  it("win32: 即使 core 上报 overlay 也不命中 overlayfs", async () => {
    const { runner } = tableRunner({});
    const backend = await probeSnapshotBackend("C:\\owc\\sess", "C:\\data\\ws", { runner, platform: "win32", core: overlayCore(true) });
    expect(backend.name).toBe("git-shadow");
  });

  it("linux: core.ping 异常时静默回落 git-shadow", async () => {
    const { runner } = tableRunner({});
    const broken: OverlayfsCore = { ping: async () => { throw new Error("core down"); } };
    const backend = await probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux", core: broken });
    expect(backend.name).toBe("git-shadow");
  });

  it("探测命令异常时回落 git-shadow，全程不 throw", async () => {
    const runner: CommandRunner = { run: async () => { throw new Error("spawn failed"); } };
    const backend = await probeSnapshotBackend("/data/sess", "/data/ws", { runner, platform: "linux" });
    expect(backend.name).toBe("git-shadow");
  });
});

describe("BtrfsBackend", () => {
  it("create/list/delete 维护元数据并发出正确命令序列", async () => {
    const root = await tempRoot("owc-btrfs-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    const snapRoot = path.join(root, ".owc-snapshots", "ws");
    const { runner, calls } = recordingRunner(() => ({ code: 0 }));
    const backend = new BtrfsBackend(workspace, runner);

    const checkpoint = await backend.create("label", 3, { round: 1 });
    expect(calls[0]).toEqual({ cmd: "btrfs", args: ["subvolume", "snapshot", "-r", workspace, path.join(snapRoot, checkpoint.id)] });
    const listed = await backend.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: checkpoint.id, label: "label", messageCount: 3, ledger: { round: 1 } });
    // 元数据与 git shadow 同形状数组，存于 snapRoot/checkpoints.json
    const raw = JSON.parse(await readFile(path.join(snapRoot, "checkpoints.json"), "utf8")) as unknown;
    expect(Array.isArray(raw)).toBe(true);

    await backend.delete(checkpoint.id);
    expect(calls[1]).toEqual({ cmd: "btrfs", args: ["subvolume", "delete", path.join(snapRoot, checkpoint.id)] });
    expect(await backend.list()).toHaveLength(0);
  });

  it("restore 先 delete 工作区再 snapshot 回来；delete 失败则中止", async () => {
    const root = await tempRoot("owc-btrfs-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    const snapRoot = path.join(root, ".owc-snapshots", "ws");
    const { runner, calls } = recordingRunner(() => ({ code: 0 }));
    const backend = new BtrfsBackend(workspace, runner);
    const checkpoint = await backend.create("label", 0);

    calls.length = 0;
    await backend.restore(checkpoint.id);
    expect(calls).toEqual([
      { cmd: "btrfs", args: ["subvolume", "delete", workspace] },
      { cmd: "btrfs", args: ["subvolume", "snapshot", path.join(snapRoot, checkpoint.id), workspace] },
    ]);

    const failing = recordingRunner((cmd, args) => (args[1] === "delete" ? { code: 1 } : { code: 0 }));
    calls.length = 0;
    await expect(new BtrfsBackend(workspace, failing.runner).restore(checkpoint.id)).rejects.toThrow();
    expect(failing.calls).toHaveLength(1);
  });

  it("diff 退出码 1 视为有差异返回文本，>1 抛错", async () => {
    const root = await tempRoot("owc-btrfs-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    const differ = recordingRunner(() => ({ stdout: "Files a and b differ\n", code: 1 }));
    const backend = new BtrfsBackend(workspace, differ.runner);
    await expect(backend.diff("snap-1-abcdef")).resolves.toContain("Files a and b differ");
    const broken = recordingRunner(() => ({ code: 2 }));
    await expect(new BtrfsBackend(workspace, broken.runner).diff("snap-1-abcdef")).rejects.toThrow();
  });
});

describe("ZfsBackend", () => {
  it("create/diff/delete 命令与元数据正确", async () => {
    const root = await tempRoot("owc-zfs-");
    const sessionRoot = path.join(root, "sess");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    const { runner, calls } = recordingRunner(() => ({ code: 0 }));
    const backend = new ZfsBackend(sessionRoot, workspace, "tank/ws", runner);

    const checkpoint = await backend.create("label", 2);
    expect(calls[0]).toEqual({ cmd: "zfs", args: ["snapshot", `tank/ws@${checkpoint.id}`] });
    // 元数据与 git shadow 一致，存于 sessionRoot/checkpoints.json
    const raw = JSON.parse(await readFile(path.join(sessionRoot, "checkpoints.json"), "utf8")) as Array<{ id: string }>;
    expect(raw.map((item) => item.id)).toEqual([checkpoint.id]);

    const differ = recordingRunner(() => ({ stdout: "M\t/ws/a.txt\n", code: 0 }));
    await expect(new ZfsBackend(sessionRoot, workspace, "tank/ws", differ.runner).diff(checkpoint.id)).resolves.toBe("M\t/ws/a.txt\n");

    await backend.delete(checkpoint.id);
    expect(calls[1]).toEqual({ cmd: "zfs", args: ["destroy", `tank/ws@${checkpoint.id}`] });
    expect(await backend.list()).toHaveLength(0);
  });

  it("restore 清空工作区（跳过 .zfs）并从只读快照复制回写", async () => {
    const root = await tempRoot("owc-zfs-");
    const sessionRoot = path.join(root, "sess");
    const workspace = path.join(root, "ws");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "a.txt"), "new", "utf8");
    await mkdir(path.join(workspace, "sub"));
    await writeFile(path.join(workspace, "sub", "b.txt"), "extra", "utf8");
    const id = "snap-1-abcdef";
    const snapshotDir = path.join(workspace, ".zfs", "snapshot", id);
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(path.join(snapshotDir, "a.txt"), "old", "utf8");
    await mkdir(sessionRoot, { recursive: true });
    await writeCheckpoints(path.join(sessionRoot, "checkpoints.json"), [{ id, label: "l", createdAt: new Date().toISOString(), messageCount: 1 }]);

    const { runner } = recordingRunner(() => ({ code: 0 }));
    const backend = new ZfsBackend(sessionRoot, workspace, "tank/ws", runner);
    await backend.restore(id);

    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old");
    await expect(stat(path.join(workspace, "sub"))).rejects.toThrow();
    // .zfs 目录本身保留
    expect((await stat(path.join(workspace, ".zfs"))).isDirectory()).toBe(true);
  });
});

describe("snapshot routes", () => {
  it("GET snapshot-capability 返回 git-shadow 并落盘 meta；DELETE checkpoint 生效并发布事件", async () => {
    const root = await tempRoot("owc-snaproute-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "a.txt"), "one", "utf8");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event) => { published.push(event); });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const agent = { isRunning: () => false } as AgentRunner;
    const app = await buildServer({ core: {} as CoreClient, sessions, agent, events, providers: new ProviderRegistry(), pricing });
    try {
      const session = await sessions.create({ cwd: workspace });

      const capability = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/snapshot-capability` });
      expect(capability.statusCode).toBe(200);
      expect(capability.json()).toMatchObject({ backend: "git-shadow", costHint: "linear", requiresAdmin: false });
      expect((await sessions.get(session.id))?.snapshotBackend).toBe("git-shadow");

      const created = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "manual" } });
      expect(created.statusCode).toBe(201);
      const checkpoint = created.json<{ id: string }>();

      const deleted = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}/checkpoints/${checkpoint.id}` });
      expect(deleted.statusCode).toBe(204);
      expect(published.some((event) => event.type === "checkpoint.deleted" && (event.payload as { id?: string }).id === checkpoint.id)).toBe(true);

      const listed = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/checkpoints` });
      expect(listed.json()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
