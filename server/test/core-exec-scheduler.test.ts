import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, CoreRpcError, type CoreInfo, type ExecRequest, type ExecResult } from "../src/core-client.js";
import { RpcTransport } from "../src/rpc/transport.js";

interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> }

const pingInfo: CoreInfo = {
  version: "test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: true, asyncExec: true, fsHash: true, fsScanPagination: true, fsWatch: true },
};

const result = (): ExecResult => ({ exitCode: 0, durationMs: 1, truncated: false, sandboxCapability: "advisory", sandboxReason: "test" });

/** Manual transport: exec.run stays pending until the test feeds a response. */
class ManualTransport extends RpcTransport {
  readonly requests: RpcRequest[] = [];
  constructor() { super(); }
  write(message: unknown): void {
    const request = message as RpcRequest;
    this.requests.push(request);
    if (request.method === "core.ping") {
      queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: request.id, result: pingInfo }));
    } else if (request.method === "core.shutdown") {
      queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: request.id, result: { ok: true } }));
    }
  }
  respond(id: number, value: unknown): void {
    this.emit("message", { jsonrpc: "2.0", id, result: value });
  }
  fail(id: number, code: number, message: string): void {
    this.emit("message", { jsonrpc: "2.0", id, error: { code, message } });
  }
  async close(): Promise<void> {}
}

let client: CoreClient | undefined;
afterEach(async () => {
  await client?.stop().catch(() => undefined);
  client = undefined;
});

async function setup(): Promise<{ client: CoreClient; transport: ManualTransport }> {
  const transport = new ManualTransport();
  const created = new CoreClient("fake", 10_000, () => Promise.resolve({ transport }));
  await created.start();
  client = created;
  return { client: created, transport };
}

const exec = (sessionId: string, execId: string): ExecRequest => ({ sessionId, execId, cmd: "echo ok", cwd: "C:\\ws", timeoutMs: 1_000 });

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("CoreClient exec 调度器", () => {
  it("并发闸门：达到上限后排队，前一条完成才发送下一条", async () => {
    const { client: target, transport } = await setup();
    target.setExecConcurrency(1);
    const first = target.run(exec("a", "a1"));
    const second = target.run(exec("b", "b1"));
    await tick();
    expect(transport.requests.filter((request) => request.method === "exec.run").map((request) => request.params.execId)).toEqual(["a1"]);

    const firstRequest = transport.requests.find((request) => request.method === "exec.run")!;
    transport.respond(firstRequest.id, result());
    await expect(first).resolves.toMatchObject({ exitCode: 0 });
    await tick();
    expect(transport.requests.filter((request) => request.method === "exec.run").map((request) => request.params.execId)).toEqual(["a1", "b1"]);

    const secondRequest = transport.requests.filter((request) => request.method === "exec.run")[1]!;
    transport.respond(secondRequest.id, result());
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
  });

  it("按会话公平：A 占满后再有 A/B 排队时，先放行 B", async () => {
    const { client: target, transport } = await setup();
    target.setExecConcurrency(2);
    const a1 = target.run(exec("a", "a1"));
    const a2 = target.run(exec("a", "a2"));
    const b1 = target.run(exec("b", "b1"));
    await tick();
    const sent = () => transport.requests.filter((request) => request.method === "exec.run").map((request) => request.params.execId);
    expect(sent()).toEqual(["a1", "a2"]);

    const first = transport.requests.find((request) => request.method === "exec.run")!;
    transport.respond(first.id, result());
    await a1;
    await tick();
    expect(sent()).toEqual(["a1", "a2", "b1"]);

    const second = transport.requests.filter((request) => request.method === "exec.run")[1]!;
    transport.respond(second.id, result());
    await a2;
    await tick();
    expect(sent()).toEqual(["a1", "a2", "b1"]);
    const third = transport.requests.filter((request) => request.method === "exec.run")[2]!;
    transport.respond(third.id, result());
    await b1;
  });

  it("取消排队项：不发送 exec.run，直接以 -32001 拒绝", async () => {
    const { client: target, transport } = await setup();
    target.setExecConcurrency(1);
    const first = target.run(exec("a", "a1"));
    const queued = target.run(exec("b", "b1"));
    await tick();
    await expect(target.cancelExec({ sessionId: "b", execId: "b1" })).resolves.toEqual({ ok: true });
    await expect(queued).rejects.toMatchObject({ code: -32001 });
    expect(transport.requests.some((request) => request.method === "exec.run" && request.params.execId === "b1")).toBe(false);

    const firstRequest = transport.requests.find((request) => request.method === "exec.run")!;
    transport.respond(firstRequest.id, result());
    await first;
  });

  it("取消运行中命令：转发 exec.cancel，原 exec.run 以 -32001 结束", async () => {
    const { client: target, transport } = await setup();
    target.setExecConcurrency(1);
    const running = target.run(exec("a", "a1"));
    await tick();
    const cancel = target.cancelExec({ sessionId: "a", execId: "a1" });
    await tick();
    const cancelRequest = transport.requests.find((request) => request.method === "exec.cancel")!;
    expect(cancelRequest.params).toMatchObject({ sessionId: "a", execId: "a1" });
    transport.respond(cancelRequest.id, { ok: true });
    await expect(cancel).resolves.toEqual({ ok: true });
    const execRequest = transport.requests.find((request) => request.method === "exec.run")!;
    transport.fail(execRequest.id, -32001, "command cancelled");
    await expect(running).rejects.toBeInstanceOf(CoreRpcError);
    await expect(running).rejects.toMatchObject({ code: -32001 });
  });
});
