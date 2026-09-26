import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, type CoreInfo } from "../src/core-client.js";
import { RpcTransport } from "../src/rpc/transport.js";
// pty.* 归属同步：core 把 sessionId 设为 pty.input/resize/close 必填字段并与 pty.open 登记的会话比对
// （缺失 -32602，不匹配 -32002）。调用点不传时 CoreClient 按登记补全——只补全、不覆盖显式值、
// 登记缺失时原样发送交给 core 拒绝。
interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> }
class FakeTransport extends RpcTransport {
  constructor(private readonly handler: (request: RpcRequest) => unknown) { super(); }
  write(message: unknown): void {
    const request = message as RpcRequest;
    queueMicrotask(() => {
      try { this.emit("message", { jsonrpc: "2.0", id: request.id, result: this.handler(request) }); }
      catch (error) {
        const failure = error as { code?: number; message?: string };
        this.emit("message", { jsonrpc: "2.0", id: request.id, error: { code: failure.code ?? -32000, message: failure.message ?? String(error) } });
      }
    });
  }
  async close(): Promise<void> {}
}


const pingInfo = (): CoreInfo => ({ version: "test", protocolVersion: "1.0", platform: "linux", sandboxCapability: "advisory", features: { pty: true } });
let ptyCounter = 0;
let unitClient: CoreClient | undefined;
/** Fake core：pty.open 分配自增 id 并登记会话；三个归属方法复刻 core 的校验 */
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
      if (typeof sessionId !== "string" || sessionId === "") throw Object.assign(new Error(`${request.method} requires non-empty string sessionId`), { code: -32602 });
      const owner = owners.get(ptyId);
      if (owner !== undefined && owner !== sessionId) throw Object.assign(new Error("pty belongs to a different session"), { code: -32002 });
      if (request.method === "pty.close") owners.delete(ptyId);
      return { ok: true };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  return { client: new CoreClient("fake", 10_000, () => Promise.resolve({ transport })), requests };
}

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
    await expect(client.closePty({ ptyId: opened.ptyId })).resolves.toEqual({ ok: true });
    const paramsOf = (method: string) => requests.find((request) => request.method === method)?.params;
    expect(paramsOf("pty.input")).toEqual({ ptyId: opened.ptyId, data: "QUJD", sessionId: "session-a" });
    expect(paramsOf("pty.resize")).toEqual({ ptyId: opened.ptyId, cols: 100, rows: 30, sessionId: "session-a" });
    expect(paramsOf("pty.close")).toEqual({ ptyId: opened.ptyId, sessionId: "session-a" });
  });

  it("显式 sessionId 原样透传（错误会话 id 由 core 以 -32002 拒绝），多会话登记互不串号", async () => {
    const { client, requests } = makeClient();
    unitClient = client;
    await client.start();
    const opened = await client.openPty({ session: "session-a", cwd: "/ws/a", cols: 80, rows: 24, sandbox: false });
    // 透传的就是调用方给的值（补全没有把错误值纠正成登记值）
    await expect(client.inputPty({ ptyId: opened.ptyId, sessionId: "session-b", data: "QUJD" })).rejects.toMatchObject({ code: -32002, message: "pty belongs to a different session" });
    expect(requests.find((request) => request.method === "pty.input")?.params).toEqual({ ptyId: opened.ptyId, sessionId: "session-b", data: "QUJD" });
    await expect(client.inputPty({ ptyId: opened.ptyId, sessionId: "session-a", data: "QUJD" })).resolves.toEqual({ ok: true });
    const other = await client.openPty({ session: "session-b", cwd: "/ws/b", cols: 80, rows: 24, sandbox: true });
    requests.length = 0;
    await Promise.all([client.inputPty({ ptyId: opened.ptyId, data: "QQ==" }), client.inputPty({ ptyId: other.ptyId, data: "Qg==" })]);
    expect(requests.map((request) => request.params)).toEqual([
      { ptyId: opened.ptyId, data: "QQ==", sessionId: "session-a" }, { ptyId: other.ptyId, data: "Qg==", sessionId: "session-b" },
    ]);
  });

  it("关闭后清掉登记：再对同一 ptyId 发 input 不再补全（core 以 -32602 拒绝）", async () => {
    const { client, requests } = makeClient();
    unitClient = client;
    await client.start();
    const opened = await client.openPty({ session: "session-a", cwd: "/ws/a", cols: 80, rows: 24, sandbox: false });
    await client.closePty({ ptyId: opened.ptyId, sessionId: "session-a" });
    requests.length = 0;
    await expect(client.inputPty({ ptyId: opened.ptyId, data: "QUJD" })).rejects.toMatchObject({ code: -32602 });
    expect(requests.at(-1)?.params).toEqual({ ptyId: opened.ptyId, data: "QUJD" }); // 登记已清空：原样发出，不含补全值
  });
});
