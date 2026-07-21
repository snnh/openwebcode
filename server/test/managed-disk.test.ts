import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { getSnapshotBackend } from "../src/snapshots/index.js";
import {
  detectManagedWorkspace,
  ManagedDiskBackend,
  managedDiskScriptPath,
  ManagedWorkspaceManager,
  managedWorkspacePaths,
  type ManagedProvisionInput,
  type ManagedWorkspaceLike,
} from "../src/snapshots/managed-disk.js";
import type { CommandRunner } from "../src/snapshots/probe.js";
import type { ManagedWorkspaceSyncApplyInput, ManagedWorkspaceSyncApplyResult, ManagedWorkspaceSyncPreview } from "../src/snapshots/managed-sync.js";
import { StorageGC } from "../src/storage-gc.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

/** 记录调用并按 handler 返回结果的 mock runner（同 snapshot-backends.test.ts 套路）。 */
function recordingRunner(handler: (cmd: string, args: string[]) => { stdout?: string; code?: number }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = {
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      const result = handler(cmd, args);
      return { stdout: result.stdout ?? "", code: result.code ?? 0 };
    },
  };
  return { runner, calls, lines: () => calls.map(({ cmd, args }) => [cmd, ...args].join(" ")) };
}

/** 按完整命令行查表；未命中返回 code 1（模拟命令失败/不存在）。 */
function tableRunner(responses: Record<string, { stdout?: string; code?: number }>) {
  return recordingRunner((cmd, args) => responses[[cmd, ...args].join(" ")] ?? { code: 1 });
}

interface TestChainState {
  active: { file: string; parentFile: string | null };
  device?: string;
  checkpoints: Array<{ id: string; label: string; createdAt: string; messageCount: number; file: string; parentFile: string | null }>;
}

async function writeChain(workspaceRoot: string, state: TestChainState): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "chain.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readChain(workspaceRoot: string): Promise<TestChainState> {
  return JSON.parse(await readFile(path.join(workspaceRoot, "chain.json"), "utf8")) as TestChainState;
}

describe("detectManagedWorkspace", () => {
  it("win32：Hyper-V 模块与当前进程访问权都可用 → vhdx 可用", async () => {
    const { runner } = tableRunner({
      "powershell -NoProfile -Command Get-Command New-VHD": { stdout: "New-VHD\r\n", code: 0 },
      "powershell -NoProfile -Command Get-VMHost -ErrorAction Stop | Out-Null": { code: 0 },
    });
    const capability = await detectManagedWorkspace("win32", runner);
    expect(capability.platform).toBe("win32");
    expect(capability.backends).toEqual([
      { backend: "vhdx", available: true, requiresAdmin: true, detail: expect.stringContaining("Hyper-V") },
    ]);
  });

  it("win32：模块缺失 → vhdx 不可用并说明原因", async () => {
    const { runner } = tableRunner({});
    const capability = await detectManagedWorkspace("win32", runner);
    expect(capability.backends[0]).toMatchObject({ backend: "vhdx", available: false, requiresAdmin: true });
    expect(capability.backends[0]?.detail).toContain("New-VHD");
  });

  it("win32：模块存在但当前 token 无 Hyper-V 访问权 → vhdx 不可用", async () => {
    const { runner, lines } = tableRunner({
      "powershell -NoProfile -Command Get-Command New-VHD": { stdout: "New-VHD\r\n", code: 0 },
      "powershell -NoProfile -Command Get-VMHost -ErrorAction Stop | Out-Null": { code: 1 },
    });
    const capability = await detectManagedWorkspace("win32", runner);
    expect(capability.backends[0]).toMatchObject({ backend: "vhdx", available: false, requiresAdmin: true });
    expect(capability.backends[0]?.detail).toContain("权限");
    expect(lines()).toEqual([
      "powershell -NoProfile -Command Get-Command New-VHD",
      "powershell -NoProfile -Command Get-VMHost -ErrorAction Stop | Out-Null",
    ]);
  });

  it("linux：qemu-img/qemu-nbd/免密 sudo 齐备 → qcow2 可用", async () => {
    const { runner } = tableRunner({
      "qemu-img --version": { stdout: "qemu-img version 8.0.0", code: 0 },
      "qemu-nbd --version": { stdout: "qemu-nbd version 8.0.0", code: 0 },
      "sudo -n true": { code: 0 },
    });
    const capability = await detectManagedWorkspace("linux", runner);
    expect(capability.backends).toEqual([
      { backend: "qcow2", available: true, requiresAdmin: true, detail: expect.stringContaining("qemu") },
    ]);
  });

  it("linux：缺免密 sudo → qcow2 不可用并列出缺失项", async () => {
    const { runner } = tableRunner({
      "qemu-img --version": { code: 0 },
      "qemu-nbd --version": { code: 0 },
    });
    const capability = await detectManagedWorkspace("linux", runner);
    expect(capability.backends[0]?.available).toBe(false);
    expect(capability.backends[0]?.detail).toContain("sudo");
  });
});

describe("managed-disk.ps1", () => {
  it("错误输出显式使用无 BOM UTF-8 stderr，供 Node 原样捕获", async () => {
    const script = await readFile(managedDiskScriptPath(), "utf8");
    expect(script).toContain("$utf8NoBom = New-Object System.Text.UTF8Encoding($false)");
    expect(script).toContain("[Console]::OutputEncoding = $utf8NoBom");
    expect(script).toContain("[Console]::OpenStandardError()");
    expect(script).toContain("$stderr.Write($bytes, 0, $bytes.Length)");
    expect(script).toContain("Write-Utf8Stderr $_.Exception.Message");
  });
});

describe("ManagedDiskBackend", () => {
  it("qcow2 create：建差分叶子+换叶命令序列正确，chain.json 记录 file=旧叶子", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const workspaceRoot = path.join(root, "workspaces", "s1");
    const mountPoint = path.join(root, "mnt", "s1");
    const base = path.join(workspaceRoot, "base.qcow2");
    await writeChain(workspaceRoot, { active: { file: base, parentFile: null }, device: "/dev/nbd2", checkpoints: [] });
    const { runner, lines } = recordingRunner(() => ({ code: 0 }));
    const backend = new ManagedDiskBackend({ kind: "qcow2", workspaceRoot, mountPoint, runner });

    const checkpoint = await backend.create("first", 5);
    const leaf = path.join(workspaceRoot, `leaf-${checkpoint.id}.qcow2`);
    expect(lines()).toEqual([
      `qemu-img create -f qcow2 -b ${base} ${leaf}`,
      `sudo umount ${mountPoint}`,
      `sudo qemu-nbd -d /dev/nbd2`,
      `sudo qemu-nbd -c /dev/nbd2 ${leaf}`,
      `sudo mount /dev/nbd2 ${mountPoint}`,
    ]);
    const state = await readChain(workspaceRoot);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]).toMatchObject({ id: checkpoint.id, label: "first", messageCount: 5, file: base, parentFile: null });
    expect(state.active).toEqual({ file: leaf, parentFile: base });
    expect((await backend.list())[0]).toMatchObject({ id: checkpoint.id, label: "first", messageCount: 5 });
  });

  it("vhdx create：new-diff + swap 脚本命令序列正确", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const workspaceRoot = path.join(root, "workspaces", "s1");
    const mountPoint = path.join(root, "mnt", "s1");
    const base = path.join(workspaceRoot, "base.vhdx");
    await writeChain(workspaceRoot, { active: { file: base, parentFile: null }, checkpoints: [] });
    const { runner, lines } = recordingRunner(() => ({ code: 0 }));
    const backend = new ManagedDiskBackend({ kind: "vhdx", workspaceRoot, mountPoint, runner });

    const checkpoint = await backend.create("first", 1);
    const leaf = path.join(workspaceRoot, `leaf-${checkpoint.id}.vhdx`);
    const script = managedDiskScriptPath();
    expect(lines()).toEqual([
      `powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -Mode new-diff -Parent ${base} -Child ${leaf}`,
      `powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -Mode swap -OldImage ${base} -NewImage ${leaf} -MountPoint ${mountPoint}`,
    ]);
    const state = await readChain(workspaceRoot);
    expect(state.checkpoints[0]).toMatchObject({ id: checkpoint.id, file: base, parentFile: null });
    expect(state.active).toEqual({ file: leaf, parentFile: base });
  });

  it("qcow2 restore：从检查点盘文件拉新分支叶子，检查点文件不被覆写", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const workspaceRoot = path.join(root, "workspaces", "s1");
    const mountPoint = path.join(root, "mnt", "s1");
    const base = path.join(workspaceRoot, "base.qcow2");
    await writeChain(workspaceRoot, { active: { file: base, parentFile: null }, device: "/dev/nbd0", checkpoints: [] });
    const { runner, calls, lines } = recordingRunner(() => ({ code: 0 }));
    const backend = new ManagedDiskBackend({ kind: "qcow2", workspaceRoot, mountPoint, runner });
    const first = await backend.create("first", 1);
    const second = await backend.create("second", 2);

    // 被回滚抛弃的当前叶子：放一个真实文件，断言 restore 后删除（非任何检查点载体）
    const previousLeaf = path.join(workspaceRoot, `leaf-${second.id}.qcow2`);
    await writeFile(previousLeaf, "stale leaf", "utf8");

    calls.length = 0;
    await backend.restore(first.id);
    // 新差分以检查点载体（base）为 backing，再换叶
    expect(lines()[0]).toMatch(new RegExp(`^qemu-img create -f qcow2 -b ${escapeRegExp(base)} `));
    expect(lines().slice(1)).toEqual([
      `sudo umount ${mountPoint}`,
      "sudo qemu-nbd -d /dev/nbd0",
      expect.stringMatching(/^sudo qemu-nbd -c \/dev\/nbd0 /),
      `sudo mount /dev/nbd0 ${mountPoint}`,
    ]);
    // base 只作为 -b 的只读 backing 出现，从不作为写目标（create 的 child 是新叶子）
    const createCall = calls.find((call) => call.cmd === "qemu-img" && call.args[0] === "create");
    expect(createCall?.args.at(-1)).not.toBe(base);
    const state = await readChain(workspaceRoot);
    expect(state.checkpoints).toHaveLength(2);
    expect(state.checkpoints[1]).toMatchObject({ id: first.id, file: base, parentFile: null });
    expect(state.active.parentFile).toBe(base);
    expect(state.active.file).toMatch(/leaf-snap-.*\.qcow2$/);
    // 旧叶子已删除，检查点载体文件不受影响
    expect(existsSync(previousLeaf)).toBe(false);
  });

  it("链长 33 触发合并（qcow2）：commit + rebase 序列，chain.json 移除最老段", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const workspaceRoot = path.join(root, "workspaces", "s1");
    const mountPoint = path.join(root, "mnt", "s1");
    const base = path.join(workspaceRoot, "base.qcow2");
    const segment = (n: number) => path.join(workspaceRoot, `seg-${n}.qcow2`);
    // 链（旧→新）：base ← seg-1 ← … ← seg-31；active = seg-32
    const checkpoints: TestChainState["checkpoints"] = [];
    for (let n = 31; n >= 1; n -= 1) {
      checkpoints.push({ id: `snap-${2000 + n}-abcdef`, label: `cp${n}`, createdAt: new Date().toISOString(), messageCount: n, file: segment(n), parentFile: n === 1 ? base : segment(n - 1) });
    }
    checkpoints.push({ id: "snap-2000-abcdef", label: "cp0", createdAt: new Date().toISOString(), messageCount: 0, file: base, parentFile: null });
    await writeChain(workspaceRoot, { active: { file: segment(32), parentFile: segment(31) }, device: "/dev/nbd0", checkpoints });
    await writeFile(segment(1), "oldest segment");
    const { runner, calls } = recordingRunner(() => ({ code: 0 }));
    const backend = new ManagedDiskBackend({ kind: "qcow2", workspaceRoot, mountPoint, runner });

    await backend.create("trigger", 99);
    const lines = calls.map(({ cmd, args }) => [cmd, ...args].join(" "));
    const commitIndex = lines.indexOf(`qemu-img commit ${segment(1)}`);
    const rebaseIndex = lines.indexOf(`qemu-img rebase -u -b ${base} ${segment(2)}`);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(rebaseIndex).toBeGreaterThan(commitIndex);
    // 最老段文件被删除，次老检查点接管 base 成为新链尾
    expect(existsSync(segment(1))).toBe(false);
    const state = await readChain(workspaceRoot);
    expect(state.checkpoints).toHaveLength(32);
    expect(state.checkpoints.at(-1)).toMatchObject({ label: "cp1", file: base, parentFile: null });
    expect(state.checkpoints.at(-2)).toMatchObject({ label: "cp2", file: segment(2), parentFile: base });
    expect(state.checkpoints.some((item) => item.label === "cp0")).toBe(false);
  });

  it("链长 33 触发合并（vhdx）：Merge-VHD + Set-VHD 序列，chain.json 移除最老段", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const workspaceRoot = path.join(root, "workspaces", "s1");
    const mountPoint = path.join(root, "mnt", "s1");
    const base = path.join(workspaceRoot, "base.vhdx");
    const segment = (n: number) => path.join(workspaceRoot, `seg-${n}.vhdx`);
    const checkpoints: TestChainState["checkpoints"] = [];
    for (let n = 31; n >= 1; n -= 1) {
      checkpoints.push({ id: `snap-${2000 + n}-abcdef`, label: `cp${n}`, createdAt: new Date().toISOString(), messageCount: n, file: segment(n), parentFile: n === 1 ? base : segment(n - 1) });
    }
    checkpoints.push({ id: "snap-2000-abcdef", label: "cp0", createdAt: new Date().toISOString(), messageCount: 0, file: base, parentFile: null });
    await writeChain(workspaceRoot, { active: { file: segment(32), parentFile: segment(31) }, checkpoints });
    const { runner, lines } = recordingRunner(() => ({ code: 0 }));
    const backend = new ManagedDiskBackend({ kind: "vhdx", workspaceRoot, mountPoint, runner });

    await backend.create("trigger", 99);
    const script = managedDiskScriptPath();
    const all = lines();
    const mergeIndex = all.indexOf(`powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -Mode merge -Path ${segment(1)}`);
    const reparentIndex = all.indexOf(`powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -Mode reparent -Path ${segment(2)} -ParentPath ${base}`);
    expect(mergeIndex).toBeGreaterThan(-1);
    expect(reparentIndex).toBeGreaterThan(mergeIndex);
    const state = await readChain(workspaceRoot);
    expect(state.checkpoints).toHaveLength(32);
    expect(state.checkpoints.at(-1)).toMatchObject({ label: "cp1", file: base, parentFile: null });
    expect(state.checkpoints.at(-2)).toMatchObject({ label: "cp2", file: segment(2), parentFile: base });
  });

  it("delete 抛明确错误：链式后端不支持逐段删除", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const workspaceRoot = path.join(root, "workspaces", "s1");
    const { runner } = recordingRunner(() => ({ code: 0 }));
    const backend = new ManagedDiskBackend({ kind: "qcow2", workspaceRoot, mountPoint: path.join(root, "mnt", "s1"), runner });
    await expect(backend.delete("snap-1-abcdef")).rejects.toThrow("managed-disk 链式后端不支持删除单个检查点；链长超 32 自动合并最老段");
  });

  it("diff 报告链中位置与载体文件信息，并如实说明无内容级 diff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const workspaceRoot = path.join(root, "workspaces", "s1");
    const mountPoint = path.join(root, "mnt", "s1");
    const base = path.join(workspaceRoot, "base.qcow2");
    await writeChain(workspaceRoot, { active: { file: base, parentFile: null }, device: "/dev/nbd0", checkpoints: [] });
    const { runner } = recordingRunner(() => ({ code: 0 }));
    const backend = new ManagedDiskBackend({ kind: "qcow2", workspaceRoot, mountPoint, runner });
    const checkpoint = await backend.create("marked", 3);
    const text = await backend.diff(checkpoint.id);
    expect(text).toContain("第 1 / 共 1 段");
    expect(text).toContain(base);
    expect(text).toContain("无廉价内容 diff");
  });

  it("capability 标注 instant/requiresAdmin 与逐段删除限制", async () => {
    const { runner } = recordingRunner(() => ({ code: 0 }));
    const backend = new ManagedDiskBackend({ kind: "vhdx", workspaceRoot: "x", mountPoint: "y", runner });
    await expect(backend.capability()).resolves.toMatchObject({ backend: "vhdx-chain", costHint: "instant", requiresAdmin: true });
  });
});

describe("getSnapshotBackend 免探测构造", () => {
  it("meta.snapshotBackend=vhdx-chain/qcow2-chain 时按名构造 ManagedDiskBackend", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const qcow2 = await sessions.create({ cwd: path.join(root, "mnt", "a") });
    await sessions.updateSnapshotBackend(qcow2.id, "qcow2-chain");
    const vhdx = await sessions.create({ cwd: path.join(root, "mnt", "b") });
    await sessions.updateSnapshotBackend(vhdx.id, "vhdx-chain");

    const qcow2Backend = await getSnapshotBackend(sessions, (await sessions.get(qcow2.id))!);
    expect(qcow2Backend).toBeInstanceOf(ManagedDiskBackend);
    expect(qcow2Backend.name).toBe("qcow2-chain");
    const vhdxBackend = await getSnapshotBackend(sessions, (await sessions.get(vhdx.id))!);
    expect(vhdxBackend).toBeInstanceOf(ManagedDiskBackend);
    expect(vhdxBackend.name).toBe("vhdx-chain");
  });
});

describe("sweepOrphans 孤儿挂载清理", () => {
  it("meta 缺失 → 卸载并删空目录；meta 在镜像缺失 → 只删目录；正常 → 跳过", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    // case1：meta 缺失 + qcow2 镜像（device 记录 /dev/nbd3）
    await mkdir(path.join(root, "mnt", "orphan1"), { recursive: true });
    await mkdir(path.join(root, "workspaces", "orphan1"), { recursive: true });
    await writeFile(path.join(root, "workspaces", "orphan1", "base.qcow2"), "img");
    await writeFile(path.join(root, "workspaces", "orphan1", "chain.json"), JSON.stringify({ active: { file: "x", parentFile: null }, device: "/dev/nbd3", checkpoints: [] }));
    // case2：meta 在 + 镜像缺失
    await mkdir(path.join(root, "sessions", "orphan2"), { recursive: true });
    await writeFile(path.join(root, "sessions", "orphan2", "meta.json"), "{}");
    await mkdir(path.join(root, "mnt", "orphan2"), { recursive: true });
    // case3：正常（meta + vhdx 镜像 + 挂载点）
    await mkdir(path.join(root, "sessions", "keep3"), { recursive: true });
    await writeFile(path.join(root, "sessions", "keep3", "meta.json"), "{}");
    await mkdir(path.join(root, "workspaces", "keep3"), { recursive: true });
    await writeFile(path.join(root, "workspaces", "keep3", "base.vhdx"), "img");
    await mkdir(path.join(root, "mnt", "keep3"), { recursive: true });

    const { runner, lines } = recordingRunner(() => ({ code: 0 }));
    const manager = new ManagedWorkspaceManager({ dataDir: root, runner, platform: "linux" });
    await manager.sweepOrphans();

    expect(lines()).toEqual([
      `sudo umount ${path.join(root, "mnt", "orphan1")}`,
      "sudo qemu-nbd -d /dev/nbd3",
    ]);
    await expect(stat(path.join(root, "mnt", "orphan1"))).rejects.toThrow();
    await expect(stat(path.join(root, "mnt", "orphan2"))).rejects.toThrow();
    expect((await stat(path.join(root, "mnt", "keep3"))).isDirectory()).toBe(true);
    // 镜像目录不在清理范围（稀疏盘由用户/后续机制处理）
    expect((await stat(path.join(root, "workspaces", "orphan1", "base.qcow2"))).isFile()).toBe(true);
  });
});

describe("StorageGC.startup", () => {
  it("启动扫描先执行附加清理再做常规 GC", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const order: string[] = [];
    const gc = new StorageGC(path.join(root, "sessions"), 1024, async () => { order.push("sweep"); });
    const report = await gc.startup();
    expect(order).toEqual(["sweep"]);
    expect(report.scanned).toBe(0);
  });
});

describe("managed workspace REST", () => {
  async function buildApp(root: string, managed?: ManagedWorkspaceLike, isRunning: () => boolean = () => false) {
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const events = new EventBus();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const agent = { isRunning } as unknown as AgentRunner;
    const core = { cleanupSession: async () => ({}), release: async () => {} } as unknown as CoreClient;
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub"));
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, ...(managed ? { managed } : {}) });
    return { app, sessions };
  }

  function fakeManaged(root: string, spies: { provision?: ManagedProvisionInput[]; teardown?: string[]; preview?: string[]; apply?: Array<{ sessionId: string; input: ManagedWorkspaceSyncApplyInput }> }): ManagedWorkspaceLike {
    const preview: ManagedWorkspaceSyncPreview = {
      baseline: { available: true, createdAt: "2026-01-01T00:00:00.000Z", version: 1 },
      fingerprint: "a".repeat(64),
      changes: [],
      summary: { create: 0, update: 0, delete: 0, conflicts: 0, unsupported: 0, unchanged: 0 },
    };
    const result = (): ManagedWorkspaceSyncApplyResult => ({ applied: [], conflicts: [], unsupported: [], nextPreview: preview });
    return {
      capability: async () => ({ platform: "linux", backends: [{ backend: "qcow2", available: true, requiresAdmin: true }] }),
      provision: async (input) => {
        spies.provision?.push(input);
        const { workspaceRoot, mountPoint } = managedWorkspacePaths(root, input.sessionId);
        return { backend: input.backend, image: path.join(workspaceRoot, "base.qcow2"), mountPoint };
      },
      previewSync: async (session) => {
        spies.preview?.push(session.id);
        return preview;
      },
      applySync: async (session, input) => {
        spies.apply?.push({ sessionId: session.id, input });
        return result();
      },
      teardown: async (session) => { spies.teardown?.push(session.id); },
    };
  }

  it("GET /api/managed-workspace/capability 返回后端能力", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const { app } = await buildApp(root, fakeManaged(root, {}));
    try {
      const response = await app.inject({ method: "GET", url: "/api/managed-workspace/capability" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ platform: "linux", backends: [{ backend: "qcow2", available: true, requiresAdmin: true }] });
    } finally {
      await app.close();
    }
  });

  it("POST /api/sessions workspaceMode=managed → 201，cwd=挂载点、meta.workspace 与 snapshotBackend 正确", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const origin = path.join(root, "origin-project");
    await mkdir(origin);
    const spies: { provision: ManagedProvisionInput[] } = { provision: [] };
    const { app, sessions } = await buildApp(root, fakeManaged(root, spies));
    try {
      const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: origin, provider: "test-stub", model: "deterministic-tool-loop", workspaceMode: "managed" } });
      expect(response.statusCode).toBe(201);
      const body = response.json<{ id: string; cwd: string; snapshotBackend?: string; workspace?: Record<string, unknown> }>();
      expect(spies.provision).toHaveLength(1);
      expect(spies.provision[0]).toMatchObject({ originCwd: origin, backend: "qcow2" });
      expect(body.id).toBe(spies.provision[0]!.sessionId);
      expect(body.cwd).toBe(path.join(root, "mnt", body.id));
      expect(body.workspace).toMatchObject({
        mode: "managed",
        backend: "qcow2",
        originCwd: path.resolve(origin),
        image: path.join(root, "workspaces", body.id, "base.qcow2"),
        mountPoint: body.cwd,
      });
      expect(body.snapshotBackend).toBe("qcow2-chain");
      const stored = await sessions.get(body.id);
      expect(stored?.workspace?.mode).toBe("managed");
      expect(stored?.snapshotBackend).toBe("qcow2-chain");
    } finally {
      await app.close();
    }
  });

  it("workspace sync REST：预览可在运行中读取，apply 要求 idle+confirm+fingerprint，并对同会话加锁", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const origin = path.join(root, "origin-project");
    await mkdir(origin);
    const spies: { preview: string[]; apply: Array<{ sessionId: string; input: ManagedWorkspaceSyncApplyInput }> } = { preview: [], apply: [] };
    let running = false;
    const managed = fakeManaged(root, spies);
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    const originalApply = managed.applySync.bind(managed);
    managed.applySync = async (session, input) => {
      signalStarted();
      await applyGate;
      return originalApply(session, input);
    };
    const { app } = await buildApp(root, managed, () => running);
    try {
      const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: origin, provider: "test-stub", model: "deterministic-tool-loop", workspaceMode: "managed" } });
      const id = created.json<{ id: string }>().id;

      running = true;
      const preview = await app.inject({ method: "GET", url: `/api/sessions/${id}/workspace/sync-preview` });
      expect(preview.statusCode).toBe(200);
      expect(spies.preview).toEqual([id]);
      const whileRunning = await app.inject({ method: "POST", url: `/api/sessions/${id}/workspace/sync`, payload: { confirm: true, previewFingerprint: "a".repeat(64) } });
      expect(whileRunning.statusCode).toBe(409);

      running = false;
      const missingConfirm = await app.inject({ method: "POST", url: `/api/sessions/${id}/workspace/sync`, payload: { previewFingerprint: "a".repeat(64) } });
      expect(missingConfirm.statusCode).toBe(400);

      const first = app.inject({ method: "POST", url: `/api/sessions/${id}/workspace/sync`, payload: { confirm: true, previewFingerprint: "a".repeat(64) } });
      await started;
      const second = await app.inject({ method: "POST", url: `/api/sessions/${id}/workspace/sync`, payload: { confirm: true, previewFingerprint: "a".repeat(64) } });
      expect(second.statusCode).toBe(409);
      const checkpoint = await app.inject({ method: "POST", url: `/api/sessions/${id}/checkpoints`, payload: { label: "blocked by sync" } });
      expect(checkpoint.statusCode).toBe(409);
      const message = await app.inject({ method: "POST", url: `/api/sessions/${id}/messages`, payload: { content: "must wait for sync" } });
      expect(message.statusCode).toBe(409);
      const pdf = await app.inject({ method: "POST", url: `/api/sessions/${id}/pdf-upload`, payload: {} });
      expect(pdf.statusCode).toBe(409);
      const shell = await app.inject({ method: "POST", url: `/api/sessions/${id}/shell`, payload: { cmd: "echo blocked" } });
      expect(shell.statusCode).toBe(409);
      const exec = await app.inject({ method: "POST", url: "/api/exec", payload: { sessionId: id, execId: "blocked", cmd: "echo blocked", cwd: origin } });
      expect(exec.statusCode).toBe(409);
      const deleting = await app.inject({ method: "DELETE", url: `/api/sessions/${id}` });
      expect(deleting.statusCode).toBe(409);
      releaseApply();
      expect((await first).statusCode).toBe(200);
      expect(spies.apply).toEqual([{ sessionId: id, input: { confirm: true, previewFingerprint: "a".repeat(64) } }]);
    } finally {
      releaseApply?.();
      await app.close();
    }
  });

  it("能力不可用时 POST managed → 400 并报明确原因", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const origin = path.join(root, "origin-project");
    await mkdir(origin);
    const unavailable: ManagedWorkspaceLike = {
      ...fakeManaged(root, {}),
      capability: async () => ({ platform: "linux", backends: [{ backend: "qcow2", available: false, requiresAdmin: true, detail: "不可用：缺少 免密 sudo（sudo -n true）" }] }),
    };
    const { app } = await buildApp(root, unavailable);
    try {
      const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: origin, provider: "test-stub", model: "deterministic-tool-loop", workspaceMode: "managed" } });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toContain("托管工作区不可用");
      expect(response.json<{ error: string }>().error).toContain("sudo");
    } finally {
      await app.close();
    }
  });

  it("非法 workspaceMode → 400；managed 源目录不存在 → 400", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const { app } = await buildApp(root, fakeManaged(root, {}));
    try {
      const invalid = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "test-stub", model: "deterministic-tool-loop", workspaceMode: "weird" } });
      expect(invalid.statusCode).toBe(400);
      const missing = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: path.join(root, "no-such-dir"), provider: "test-stub", model: "deterministic-tool-loop", workspaceMode: "managed" } });
      expect(missing.statusCode).toBe(400);
      expect(missing.json<{ error: string }>().error).toContain("源目录不存在");
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/sessions：managed 会话先 teardown（卸载+删目录）再删会话", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-md-")); roots.push(root);
    const origin = path.join(root, "origin-project");
    await mkdir(origin);
    const spies: { teardown: string[] } = { teardown: [] };
    const { app, sessions } = await buildApp(root, fakeManaged(root, spies));
    try {
      const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: origin, provider: "test-stub", model: "deterministic-tool-loop", workspaceMode: "managed" } });
      const id = created.json<{ id: string }>().id;
      const deleted = await app.inject({ method: "DELETE", url: `/api/sessions/${id}` });
      expect(deleted.statusCode).toBe(204);
      expect(spies.teardown).toEqual([id]);
      expect(await sessions.get(id)).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
