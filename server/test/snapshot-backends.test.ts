import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import * as treeDiffModule from "../src/snapshots/tree-diff.js";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { activePathMessages } from "../src/sessions/session-tree.js";
import { writeCheckpoints } from "../src/snapshots/backend.js";
import { BtrfsBackend } from "../src/snapshots/btrfs.js";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";
import { probeSnapshotBackend, probeSnapshotBackendByName, type CommandRunner } from "../src/snapshots/probe.js";
import type { OverlayfsCore } from "../src/snapshots/overlayfs.js";
import type { CoreInfo } from "../src/core-client.js";
import { ZfsBackend } from "../src/snapshots/zfs.js";

import { FAKE_CORE_INFO } from "./helpers/fake-core.js";
import { recordingRunner, tableRunner } from "./helpers/recording-runner.js";
import { tempRoot } from "./helpers/temp-roots.js";

const execFileAsync = promisify(execFile);

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

  // B10：现场探测出的实例必须与 constructByName 同参数携带 excludes/denyPaths，
  // 否则「探测后首次」diff 会展示 deny/排除路径、首次回退会覆盖 deny 文件。
  it("linux: 探测出的 btrfs 实例携带会话 excludes 与 denyPaths", async () => {
    const root = await tempRoot("owc-probe-deny-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    await writeFile(path.join(workspace, ".env"), "SECRET=current", "utf8");
    const denyPaths = [path.join(workspace, ".env")];
    const excludes = { excludePrefixes: [".env"], excludeGlobs: [] };
    const spy = vi.spyOn(treeDiffModule, "diffTrees").mockResolvedValue("unified diff");
    try {
      const runner = recordingRunner((cmd, args) => {
        if (cmd === "stat") return { stdout: "btrfs\n", code: 0 };
        // 只在 restore 的 snapshot（无 -r）时物化「快照内容」，create 的 -r 快照不动工作区
        if (args[1] === "snapshot" && args[2] !== "-r") {
          // 模拟「快照内容」落进工作区（含旧 .env），等价真实重建
          mkdirSync(workspace, { recursive: true });
          writeFileSync(path.join(workspace, ".env"), "SECRET=snapshot-old");
        }
        return { code: 0 };
      });
      const probed = await probeSnapshotBackend(root, workspace, { runner: runner.runner, platform: "linux", excludes, denyPaths });
      expect(probed.name).toBe("btrfs");
      // 首次 diff 就走会话 excludes（.env 不出现）
      await probed.diff("snap-1-abcdef");
      expect(spy).toHaveBeenLastCalledWith(path.join(root, ".owc-snapshots", "ws", "snap-1-abcdef"), workspace, excludes);
      // 首次回退保留 deny 文件当前内容
      const checkpoint = await probed.create("label", 0);
      await probed.restore(checkpoint.id);
      expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=current");
    } finally {
      spy.mockRestore();
    }
  });

  it("win32: 探测出的 refs 实例携带会话 excludes", async () => {
    const excludes = { excludePrefixes: [".env"], excludeGlobs: ["*.log"] };
    const spy = vi.spyOn(treeDiffModule, "diffTrees").mockResolvedValue("unified diff");
    try {
      const { runner } = tableRunner({
        "powershell -NoProfile -Command (Get-Volume -DriveLetter C).FileSystem -eq 'ReFS'": { stdout: "True\r\n", code: 0 },
      });
      const probed = await probeSnapshotBackend("C:\\owc\\sess", "C:\\data\\ws", { runner, platform: "win32", excludes });
      expect(probed.name).toBe("refs");
      await probed.diff("snap-1-abcdef");
      expect(spy).toHaveBeenLastCalledWith(expect.stringContaining("refs-snaps"), "C:\\data\\ws", excludes);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("probeSnapshotBackendByName（设置偏好的单后端探测）", () => {
  it("linux: 指定 btrfs 且命中", async () => {
    const { runner } = tableRunner({
      "stat -f -c %T /data/ws": { stdout: "btrfs\n", code: 0 },
      "btrfs subvolume show /data/ws": { code: 0 },
    });
    const backend = await probeSnapshotBackendByName("btrfs", "/data/sess", "/data/ws", { runner, platform: "linux" });
    expect(backend?.name).toBe("btrfs");
  });

  it("指定 btrfs 但工作区不是 btrfs → undefined（不探测链回落）", async () => {
    const { runner } = tableRunner({
      "stat -f -c %T /data/ws": { stdout: "ext4\n", code: 0 },
    });
    const backend = await probeSnapshotBackendByName("btrfs", "/data/sess", "/data/ws", { runner, platform: "linux" });
    expect(backend).toBeUndefined();
  });

  it("平台不符：win32 指定 btrfs / linux 指定 refs → undefined", async () => {
    const { runner } = tableRunner({});
    await expect(probeSnapshotBackendByName("btrfs", "C:\\owc\\sess", "C:\\data\\ws", { runner, platform: "win32" })).resolves.toBeUndefined();
    await expect(probeSnapshotBackendByName("refs", "/data/sess", "/data/ws", { runner, platform: "linux" })).resolves.toBeUndefined();
  });

  it("linux: 指定 overlayfs 按 core 能力判定", async () => {
    const { runner } = tableRunner({});
    await expect(probeSnapshotBackendByName("overlayfs", "/data/sess", "/data/ws", { runner, platform: "linux", core: overlayCore(true) })).resolves.toMatchObject({ name: "overlayfs" });
    await expect(probeSnapshotBackendByName("overlayfs", "/data/sess", "/data/ws", { runner, platform: "linux" })).resolves.toBeUndefined();
  });

  it("git-shadow 任意平台直接构造；未知名返回 undefined", async () => {
    const { runner } = tableRunner({});
    await expect(probeSnapshotBackendByName("git-shadow", "/data/sess", "/data/ws", { runner, platform: "linux" })).resolves.toMatchObject({ name: "git-shadow" });
    await expect(probeSnapshotBackendByName("zfs-with-dataset", "/data/sess", "/data/ws", { runner, platform: "linux" })).resolves.toBeUndefined();
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

  it("restore 先验证快照源、改名旧子卷再从快照重建，最后清理旧子卷", async () => {
    const root = await tempRoot("owc-btrfs-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    const snapRoot = path.join(root, ".owc-snapshots", "ws");
    const { runner, calls } = recordingRunner(() => ({ code: 0 }));
    const backend = new BtrfsBackend(workspace, runner);
    const checkpoint = await backend.create("label", 0);

    calls.length = 0;
    await backend.restore(checkpoint.id);
    // 顺序：验证快照源可用 → 重建到工作区路径 → 清理改名后的旧子卷
    expect(calls[0]).toEqual({ cmd: "btrfs", args: ["subvolume", "show", path.join(snapRoot, checkpoint.id)] });
    expect(calls[1]).toEqual({ cmd: "btrfs", args: ["subvolume", "snapshot", path.join(snapRoot, checkpoint.id), workspace] });
    expect(calls[2]).toMatchObject({ cmd: "btrfs", args: ["subvolume", "delete", expect.stringMatching(/ws\.owc-restore-/)] });
    // 先删工作区再重建的旧序列不再出现（工作区路径不做 delete）
    expect(calls.some((call) => call.args[1] === "delete" && call.args[2] === workspace)).toBe(false);
  });

  it("restore 重建失败时回滚：旧工作区仍在（数据不丢）", async () => {
    const root = await tempRoot("owc-btrfs-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "keep.txt"), "current", "utf8");
    const { runner } = recordingRunner(() => ({ code: 0 }));
    const checkpoint = await new BtrfsBackend(workspace, runner).create("label", 0);

    const failing = recordingRunner((cmd, args) => (args[1] === "snapshot" ? { code: 1 } : { code: 0 }));
    await expect(new BtrfsBackend(workspace, failing.runner).restore(checkpoint.id)).rejects.toThrow(/btrfs snapshot failed/);
    // 旧工作区改名回了原位：内容与回退前一致
    expect(await readFile(path.join(workspace, "keep.txt"), "utf8")).toBe("current");
    // 临时改名残留已收回
    expect((await readdir(root)).filter((entry) => entry.startsWith("ws.owc-restore-"))).toEqual([]);
  });

  it("restore 用当前 deny 内容回写（整卷回退不覆盖/不新增 deny 文件）", async () => {
    const root = await tempRoot("owc-btrfs-");
    const workspace = path.join(root, "ws");
    await mkdir(path.join(workspace, ".owc"), { recursive: true });
    await writeFile(path.join(workspace, ".env"), "SECRET=current", "utf8");
    const denyPaths = [path.join(workspace, ".env"), path.join(workspace, ".owc", "hooks.json")];
    const { runner } = recordingRunner(() => ({ code: 0 }));
    const checkpoint = await new BtrfsBackend(workspace, runner, undefined, denyPaths).create("label", 0);

    // mock：snapshot 子命令时物化「快照内容」（含旧 .env），模拟真实重建
    const materialize = recordingRunner((_cmd, args) => {
      if (args[1] === "snapshot") {
        mkdirSync(workspace, { recursive: true });
        writeFileSync(path.join(workspace, ".env"), "SECRET=snapshot-old");
      }
      return { code: 0 };
    });
    await new BtrfsBackend(workspace, materialize.runner, undefined, denyPaths).restore(checkpoint.id);

    // 当前 deny 内容不被快照旧值覆盖
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=current");
    // 回退前不存在的 deny 文件不会被凭空造出
    await expect(stat(path.join(workspace, ".owc", "hooks.json"))).rejects.toThrow();
  });

  it("diff 退出码 1 视为有差异返回文本，>1 抛错（git 缺失时走摘要降级）", async () => {
    const root = await tempRoot("owc-btrfs-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    // diffTrees 返回 null（git 缺失）时后端降级到 btrfs 摘要（退出码 1 = 有差异）
    const spy = vi.spyOn(treeDiffModule, "diffTrees").mockResolvedValue(null);
    try {
      const differ = recordingRunner(() => ({ stdout: "Files a and b differ\n", code: 1 }));
      const backend = new BtrfsBackend(workspace, differ.runner);
      await expect(backend.diff("snap-1-abcdef")).resolves.toContain("Files a and b differ");
      const broken = recordingRunner(() => ({ code: 2 }));
      await expect(new BtrfsBackend(workspace, broken.runner).diff("snap-1-abcdef")).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
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
    // 暂存目录不残留
    expect((await readdir(workspace)).filter((entry) => entry.startsWith(".owc-restore-"))).toEqual([]);
  });

  it("restore 保留当前 deny 文件内容与权限位，不新增快照里没有的 deny 文件", async () => {
    const root = await tempRoot("owc-zfs-");
    const sessionRoot = path.join(root, "sess");
    const workspace = path.join(root, "ws");
    await mkdir(path.join(workspace, ".owc"), { recursive: true });
    await writeFile(path.join(workspace, ".env"), "SECRET=current", { encoding: "utf8", mode: 0o600 });
    await writeFile(path.join(workspace, ".owc", "mcp.json"), "current-mcp", "utf8");
    await writeFile(path.join(workspace, "mod.txt"), "current", "utf8");
    const id = "snap-1-abcdef";
    const snapshotDir = path.join(workspace, ".zfs", "snapshot", id);
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(path.join(snapshotDir, ".env"), "SECRET=snapshot-old", "utf8");
    await writeFile(path.join(snapshotDir, "mod.txt"), "old", "utf8");
    await mkdir(sessionRoot, { recursive: true });
    await writeCheckpoints(path.join(sessionRoot, "checkpoints.json"), [{ id, label: "l", createdAt: new Date().toISOString(), messageCount: 1 }]);

    const denyPaths = [path.join(workspace, ".env"), path.join(workspace, ".owc", "mcp.json"), path.join(workspace, ".owc", "hooks.json")];
    const { runner } = recordingRunner(() => ({ code: 0 }));
    await new ZfsBackend(sessionRoot, workspace, "tank/ws", runner, undefined, denyPaths).restore(id);

    // 普通文件回到快照内容
    expect(await readFile(path.join(workspace, "mod.txt"), "utf8")).toBe("old");
    // deny 文件保持回退前的内容与权限位（不被快照旧值覆盖）
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=current");
    expect((await stat(path.join(workspace, ".env"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(workspace, ".owc", "mcp.json"), "utf8")).toBe("current-mcp");
    // 回退前不存在的 deny 文件不凭空造出
    await expect(stat(path.join(workspace, ".owc", "hooks.json"))).rejects.toThrow();
  });

  it("restore 复制失败时回滚：旧工作区仍在（数据不丢）", async () => {
    const root = await tempRoot("owc-zfs-");
    const sessionRoot = path.join(root, "sess");
    const workspace = path.join(root, "ws");
    await mkdir(path.join(workspace, "sub"), { recursive: true });
    await writeFile(path.join(workspace, "a.txt"), "current", "utf8");
    await writeFile(path.join(workspace, "sub", "b.txt"), "extra", "utf8");
    const id = "snap-1-abcdef";
    const snapshotDir = path.join(workspace, ".zfs", "snapshot", id);
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(path.join(snapshotDir, "a.txt"), "old", "utf8");
    await mkdir(sessionRoot, { recursive: true });
    await writeCheckpoints(path.join(sessionRoot, "checkpoints.json"), [{ id, label: "l", createdAt: new Date().toISOString(), messageCount: 1 }]);

    class FailingZfs extends ZfsBackend {
      protected override async copyFromSnapshot(): Promise<void> {
        throw new Error("copy failed");
      }
    }
    const { runner } = recordingRunner(() => ({ code: 0 }));
    await expect(new FailingZfs(sessionRoot, workspace, "tank/ws", runner).restore(id)).rejects.toThrow(/copy failed/);

    // 回滚后当前内容仍在，暂存目录已收回，.zfs 保留
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("current");
    expect(await readFile(path.join(workspace, "sub", "b.txt"), "utf8")).toBe("extra");
    expect((await readdir(workspace)).filter((entry) => entry.startsWith(".owc-restore-"))).toEqual([]);
    expect((await stat(path.join(workspace, ".zfs"))).isDirectory()).toBe(true);
  });

  it("restore 快照源不可读时不动工作区", async () => {
    const root = await tempRoot("owc-zfs-");
    const sessionRoot = path.join(root, "sess");
    const workspace = path.join(root, "ws");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "a.txt"), "current", "utf8");
    const id = "snap-1-abcdef";
    await mkdir(sessionRoot, { recursive: true });
    await writeCheckpoints(path.join(sessionRoot, "checkpoints.json"), [{ id, label: "l", createdAt: new Date().toISOString(), messageCount: 1 }]);

    const { runner } = recordingRunner(() => ({ code: 0 }));
    const backend = new ZfsBackend(sessionRoot, workspace, "tank/ws", runner);
    await expect(backend.restore(id)).rejects.toThrow(/not accessible/);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("current");
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

  // B2：非托管会话的 acquireManagedWorkspaceExclusive 是 no-op，git-shadow 等后端并发
  // POST /checkpoints 会撞 git index.lock、checkpoints.json 读改写丢条目 —— per-session
  // 快照锁必须让并发请求一个成功、一个 409，且元数据只剩一条。
  it("并发 POST /checkpoints 串行化：一个 201 一个 409，条目不丢", async () => {
    const root = await tempRoot("owc-snaproute-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "a.txt"), "one", "utf8");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const events = new EventBus();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const agent = { isRunning: () => false } as AgentRunner;
    const app = await buildServer({ core: {} as CoreClient, sessions, agent, events, providers: new ProviderRegistry(), pricing });
    try {
      const session = await sessions.create({ cwd: workspace });
      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "c1" } }),
        app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "c2" } }),
      ]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
      // 非托管会话（git-shadow）如实描述冲突来源
      const conflict = first.statusCode === 409 ? first : second;
      expect(conflict.json()).toMatchObject({ error: "A checkpoint operation is already in progress for this session" });
      const listed = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/checkpoints` });
      expect(listed.json()).toHaveLength(1);
      // 锁在请求结束后释放：串行再建一个检查点仍可成功
      const third = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "c3" } });
      expect(third.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  // B1 路由侧回归：建检查点 → 再发消息 → 回退 → 再发消息，活动路径必须完整
  it("POST restore 回退消息后活动叶子重置，后续追加的活动路径完整", async () => {
    const root = await tempRoot("owc-snaproute-");
    const workspace = path.join(root, "ws");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "a.txt"), "one", "utf8");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const events = new EventBus();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const agent = { isRunning: () => false } as AgentRunner;
    const app = await buildServer({ core: {} as CoreClient, sessions, agent, events, providers: new ProviderRegistry(), pricing });
    try {
      const session = await sessions.create({ cwd: workspace });
      const early = [];
      for (let index = 0; index < 3; index++) {
        early.push(await sessions.appendMessage(session.id, "user", [{ type: "text", text: `m${index}` }]));
      }
      const created = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "cp" } });
      expect(created.statusCode).toBe(201);
      const checkpoint = created.json<{ id: string; messageCount: number }>();
      expect(checkpoint.messageCount).toBe(3);

      await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "later" }]);
      const restored = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`,
        payload: { confirm: true },
      });
      expect(restored.statusCode).toBe(200);

      const afterRestore = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "after" }]);
      const detail = await sessions.get(session.id);
      expect(detail!.messages).toHaveLength(4);
      expect(detail!.activeLeafId).toBe(afterRestore.id);
      expect(activePathMessages(detail!.messages, detail!.activeLeafId).map((message) => message.id))
        .toEqual([...early.map((message) => message.id), afterRestore.id]);
    } finally {
      await app.close();
    }
  });
});

// ---- git-shadow 组（合并） ----
describe("GitShadowSnapshots", () => {
  it("restores an empty-tree checkpoint by clearing the workspace", async () => {
    const root = await tempRoot("owc-shadow-empty-");
    const workspace = path.join(root, "workspace");
    const session = path.join(root, "session");
    await mkdir(workspace);
    const snapshots = new GitShadowSnapshots(session, workspace);
    const checkpoint = await snapshots.create("empty baseline", 0, { round: 0 });

    await writeFile(path.join(workspace, "later.txt"), "added after the checkpoint", "utf8");
    await snapshots.restore(checkpoint.id);
    await expect(readFile(path.join(workspace, "later.txt"), "utf8")).rejects.toThrow();
  });

  it("captures tracked and untracked files outside the workspace and restores them", async () => {
    const root = await tempRoot("owc-shadow-");
    const workspace = path.join(root, "workspace");
    const session = path.join(root, "session");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "a.txt"), "one", "utf8");
    await writeFile(path.join(workspace, "untracked.txt"), "keep", "utf8");
    await writeFile(path.join(workspace, ".gitignore"), "*.cache\n", "utf8");
    await writeFile(path.join(workspace, "saved.cache"), "saved", "utf8");
    const snapshots = new GitShadowSnapshots(session, workspace);
    expect(await snapshots.capability()).toMatchObject({ backend: "git-shadow", requiresAdmin: false });
    const checkpoint = await snapshots.create("before edit", 2, { round: 1 });

    await writeFile(path.join(workspace, "a.txt"), "two", "utf8");
    await rm(path.join(workspace, "untracked.txt"));
    await writeFile(path.join(workspace, "new.txt"), "new", "utf8");
    await writeFile(path.join(workspace, "new.cache"), "ignored", "utf8");
    await writeFile(path.join(workspace, "saved.cache"), "changed", "utf8");
    // diff 返回 stat 摘要 + 完整 unified diff（供 Web diff 视图 hunk 解析）
    const diffText = await snapshots.diff(checkpoint.id);
    expect(diffText).toContain("a.txt");
    expect(diffText).toContain("diff --git a/a.txt b/a.txt");
    expect(diffText).toMatch(/@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/);
    expect(diffText).toContain("-one");
    expect(diffText).toContain("+two");
    await snapshots.restore(checkpoint.id);
    const restored = (await snapshots.list()).find((item) => item.id === checkpoint.id);

    expect(restored?.ledger).toEqual({ round: 1 });
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe("keep");
    expect(await readFile(path.join(workspace, "saved.cache"), "utf8")).toBe("saved");
    await expect(readFile(path.join(workspace, "new.cache"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace, "new.txt"), "utf8")).rejects.toThrow();
  });

  // B9：`add -u` 会把「已被跟踪、检查点之后才加入 deny」的路径改动也暂存进快照。
  it("检查点之后加入 deny 的已跟踪文件改动不进快照", async () => {
    const root = await tempRoot("owc-shadow-deny-");
    const workspace = path.join(root, "workspace");
    const session = path.join(root, "session");
    await mkdir(workspace);
    await writeFile(path.join(workspace, ".env"), "SECRET=original", "utf8");
    await writeFile(path.join(workspace, "app.txt"), "v1", "utf8");
    // 首个检查点：.env 尚未被 deny（git-shadow 默认排除项不含 .env）→ 正常跟踪进快照
    const baseline = new GitShadowSnapshots(session, workspace);
    const first = await baseline.create("baseline", 1);
    expect(await gitShow(session, workspace, `${first.id}:.env`)).toBe("SECRET=original");

    await writeFile(path.join(workspace, ".env"), "SECRET=changed", "utf8");
    await writeFile(path.join(workspace, "app.txt"), "v2", "utf8");
    // 此时 .env 加入会话 deny：add -u 的暂存必须在提交前撤出该路径
    const guarded = new GitShadowSnapshots(session, workspace, { denyPaths: [path.join(workspace, ".env")] });
    const second = await guarded.create("guarded", 2);
    expect(await gitShow(session, workspace, `${second.id}:.env`)).toBe("SECRET=original");
    expect(await gitShow(session, workspace, `${second.id}:app.txt`)).toBe("v2");
    // 工作区里的改动仍在（只是没进快照）
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=changed");
  });
});

/** 读影子仓库里某个检查点版本的路径内容（git show <sha>:<path>）。 */
async function gitShow(sessionRoot: string, workspace: string, spec: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--git-dir", path.join(sessionRoot, "shadow.git"), "--work-tree", workspace, "show", spec]);
  return stdout;
}
