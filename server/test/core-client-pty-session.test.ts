import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, type CoreInfo } from "../src/core-client.js";
import { RpcTransport } from "../src/rpc/transport.js";

/**
 * pty.* 归属同步（C4）：core 把 `sessionId` 设为 pty.input / pty.resize /
 * pty.close 的必填字段并与 pty.open 记录的会话比对（缺失 -32602，不匹配
 * -32002）。调用点应显式传自身会话 id；server/src/agent/persistent-shell.ts
 * 等既有调用点不传，由 CoreClient 按 pty.open 登记补全——这些用例钉住补全
 * 语义：只补全、不覆盖显式值、登记缺失时原样发送（交给 core 拒绝）。
 */

interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> }
type Handler = (request: RpcRequest) => unknown;

class FakeTransport extends RpcTransport {
  constructor(private readonly handler: Handler) {
    super();
  }

  write(message: unknown): void {
    const request = message as RpcRequest;
    queueMicrotask(() => {
      try {
        this.emit("message", { jsonrpc: "2.0", id: request.id, result: this.handler(request) });
      } catch (error) {
        const failure = error as { code?: number; message?: string };
        this.emit("message", {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: failure.code ?? -32000, message: failure.message ?? String(error) },
        });
      }
    });
  }

  async close(): Promise<void> {}
}

function pingInfo(): CoreInfo {
  return {
    version: "test",
    protocolVersion: "1.0",
    platform: "linux",
    sandboxCapability: "advisory",
    features: { pty: true },
  };
}

let ptyCounter = 0;

/** Fake core: pty.open 分配自增 id；三个归属方法复刻 core 的校验（缺失/非字符串
 * -32602，与登记不匹配 -32002）。 */
function makeClient(): { client: CoreClient; requests: RpcRequest[] } {
  const requests: RpcRequest[] = [];
  const owners = new Map<number, string>();
  const transport = new FakeTransport((request) => {
    requests.push(request);
    if (request.method === "core.ping") return pingInfo();
    if (request.method === "pty.open") {
      const ptyId = ++ptyCounter;
      owners.set(ptyId, String(request.params.session));
      return { ptyId, sandboxCapability: "advisory", sandboxReason: "sandbox disabled by session policy" };
    }
    if (request.method === "pty.input" || request.method === "pty.resize" || request.method === "pty.close") {
      const ptyId = Number(request.params.ptyId);
      const sessionId = request.params.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") {
        throw Object.assign(new Error(`${request.method} requires non-empty string sessionId`), { code: -32602 });
      }
      const owner = owners.get(ptyId);
      if (owner !== undefined && owner !== sessionId) {
        throw Object.assign(new Error("pty belongs to a different session"), { code: -32002 });
      }
      if (request.method === "pty.close") owners.delete(ptyId);
      return { ok: true };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  return { client: new CoreClient("fake", 10_000, () => Promise.resolve({ transport })), requests };
}

let unitClient: CoreClient | undefined;

afterEach(async () => {
  await unitClient?.stop().catch(() => undefined);
  unitClient = undefined;
});

describe("CoreClient pty.* session binding", () => {
  it("补全归属：省略 sessionId 时按 pty.open 登记值补全（pty.input/resize/close）", async () => {
    const { client, requests } = makeClient();
    unitClient = client;
    await client.start();

    const opened = await client.openPty({ session: "session-a", cwd: "/ws/a", cols: 80, rows: 24, sandbox: false });
    await client.inputPty({ ptyId: opened.ptyId, data: "QUJD" });
    await client.resizePty({ ptyId: opened.ptyId, cols: 100, rows: 30 });
    const closed = await client.closePty({ ptyId: opened.ptyId });
    expect(closed).toEqual({ ok: true });

    const input = requests.find((request) => request.method === "pty.input");
    expect(input?.params).toEqual({ ptyId: opened.ptyId, data: "QUJD", sessionId: "session-a" });
    const resize = requests.find((request) => request.method === "pty.resize");
    expect(resize?.params).toEqual({ ptyId: opened.ptyId, cols: 100, rows: 30, sessionId: "session-a" });
    const close = requests.find((request) => request.method === "pty.close");
    expect(close?.params).toEqual({ ptyId: opened.ptyId, sessionId: "session-a" });
  });

  it("显式 sessionId 原样透传：写错不匹配的会话 id 由 core 以 -32002 拒绝", async () => {
    const { client, requests } = makeClient();
    unitClient = client;
    await client.start();

    const opened = await client.openPty({ session: "session-a", cwd: "/ws/a", cols: 80, rows: 24, sandbox: false });
    await expect(
      client.inputPty({ ptyId: opened.ptyId, sessionId: "session-b", data: "QUJD" }),
    ).rejects.toMatchObject({ code: -32002, message: "pty belongs to a different session" });
    // 透传的就是调用方给的值（补全没有把错误值纠正成登记值）
    const input = requests.find((request) => request.method === "pty.input");
    expect(input?.params).toEqual({ ptyId: opened.ptyId, sessionId: "session-b", data: "QUJD" });

    // 归属正确时显式传入同样可用
    await expect(client.inputPty({ ptyId: opened.ptyId, sessionId: "session-a", data: "QUJD" })).resolves.toEqual({ ok: true });
  });

  it("登记只属于开出它的会话：两个会话的 pty 互不串号", async () => {
    const { client, requests } = makeClient();
    unitClient = client;
    await client.start();

    const a = await client.openPty({ session: "session-a", cwd: "/ws/a", cols: 80, rows: 24, sandbox: false });
    const b = await client.openPty({ session: "session-b", cwd: "/ws/b", cols: 80, rows: 24, sandbox: true });
    await client.inputPty({ ptyId: a.ptyId, data: "QQ==" });
    await client.inputPty({ ptyId: b.ptyId, data: "Qg==" });

    const sends = requests.filter((request) => request.method === "pty.input").map((request) => request.params);
    expect(sends).toEqual([
      { ptyId: a.ptyId, data: "QQ==", sessionId: "session-a" },
      { ptyId: b.ptyId, data: "Qg==", sessionId: "session-b" },
    ]);
  });

  it("关闭后清掉登记：再对同一 ptyId 发 input 时不再补全（core 以 -32602 拒绝）", async () => {
    const { client, requests } = makeClient();
    unitClient = client;
    await client.start();

    const opened = await client.openPty({ session: "session-a", cwd: "/ws/a", cols: 80, rows: 24, sandbox: false });
    await client.closePty({ ptyId: opened.ptyId, sessionId: "session-a" });
    requests.length = 0;
    await expect(client.inputPty({ ptyId: opened.ptyId, data: "QUJD" })).rejects.toMatchObject({ code: -32602 });
    expect(requests.at(-1)?.params).toEqual({ ptyId: opened.ptyId, data: "QUJD" });
  });
});
