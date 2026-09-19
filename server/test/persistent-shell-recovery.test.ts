import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PersistentShellManager, PersistentShellUnavailableError } from "../src/agent/persistent-shell.js";
import type { CoreClientLike, PtyOpenResult } from "../src/core-client.js";
import { NodeEnvManagers } from "../src/node-env.js";
import { UvPythonEnvironments } from "../src/python-env.js";
import type { SessionMeta } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * 最小 pty fake：openPty 立即成功，inputPty 回送 sentinel 行（exit code 可配）。
 * 用于「建壳 init 失败 → 回退一次性 exec」这条路，验证 initFailed 缓存可被回收。
 */
function makePtyCore(initCode: number): { core: CoreClientLike; openCalls: () => number } {
  let ptySeq = 0;
  let openCalls = 0;
  const emitters = new Map<number, EventEmitter>();
  const core = {
    on() { return core; },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async openPty() {
      openCalls += 1;
      const ptyId = ++ptySeq;
      emitters.set(ptyId, new EventEmitter());
      return { ptyId, sandboxCapability: "advisory" } as PtyOpenResult;
    },
    async inputPty({ ptyId, data }: { ptyId: number; data: string }) {
      const emitter = emitters.get(ptyId);
      const payload = Buffer.from(data, "base64").toString("utf8");
      const rand = /__OWC_DONE_([0-9a-f]{12})_/.exec(payload)?.[1];
      if (emitter && rand) {
        // 异步回送：模拟 shell 对 sentinel 输入行的输出
        setTimeout(() => {
          emitter.emit("output", { data: Buffer.from(`\r\n__OWC_DONE_${rand}_${initCode}__\r\n`, "utf8").toString("base64") });
        }, 0);
      }
      return { ok: true as const };
    },
    async closePty() { return { ok: true as const }; },
    ptyEvents(ptyId: number) { return emitters.get(ptyId) ?? new EventEmitter(); },
    removePtyEvents(ptyId: number) { emitters.delete(ptyId); },
  } as unknown as CoreClientLike;
  return { core, openCalls: () => openCalls };
}

describe("持久 shell 初始化失败缓存回收", () => {
  it("disposeSession 清理 initFailed，环境修复后重新尝试建壳", async () => {
    const root = await tempRoot("owc-persistent-shell-");
    const { core, openCalls } = makePtyCore(1); // init 退出码非零 = 进不了会话 cwd
    const manager = new PersistentShellManager(core, new UvPythonEnvironments(), () => "global", new NodeEnvManagers(), () => "global");
    const session = { id: "session-1", cwd: root, provider: "test", model: "test-model" } as SessionMeta;
    const signal = new AbortController().signal;

    await expect(manager.run(session, "echo hi", signal)).rejects.toThrow(PersistentShellUnavailableError);
    expect(openCalls()).toBe(1);
    // 同一 session:backend 命中失败缓存：直接回退一次性 exec，不再付开壳代价
    await expect(manager.run(session, "echo hi", signal)).rejects.toThrow(/previously failed/);
    expect(openCalls()).toBe(1);

    // 会话配置变更/删除 → 清缓存：修复环境后必须能重试（否则该会话永久退化为一次性 exec）
    manager.disposeSession(session.id);
    await expect(manager.run(session, "echo hi", signal)).rejects.toThrow(PersistentShellUnavailableError);
    expect(openCalls()).toBe(2);
    expect((manager as unknown as { initFailed: Set<string> }).initFailed.size).toBe(1); // 本次失败重新记录

    // 其它会话的缓存不受影响
    manager.disposeSession("session-2");
    expect((manager as unknown as { initFailed: Set<string> }).initFailed.size).toBe(1);
  }, 20_000);
});
