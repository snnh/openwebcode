import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreClient, type CoreInfo } from "../src/core-client.js";
import { RpcTransport } from "../src/rpc/transport.js";
interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> }
type Handler = (request: RpcRequest) => unknown;

/** 内存 RpcTransport：write 按 id 异步回包，配合 CoreClient 的 connectionFactory 注入 */
class FakeTransport extends RpcTransport {
  constructor(private readonly handler: Handler) { super(); }

  write(message: unknown): void {
    const request = message as RpcRequest;
    queueMicrotask(() => {
      try {
        this.emit("message", { jsonrpc: "2.0", id: request.id, result: this.handler(request) });
      } catch (error) {
        const failure = error as { code?: number; message?: string };
        this.emit("message", { jsonrpc: "2.0", id: request.id, error: { code: failure.code ?? -32000, message: failure.message ?? String(error) } });
      }
    });
  }

  async close(): Promise<void> {}
}

const pingInfo = (features: Record<string, boolean> = {}): CoreInfo => ({
  version: "test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: true, fsHash: true, fsScanPagination: true, fsWatch: true, ...features },
});

function makeClient(handler: Handler): { client: CoreClient; requests: RpcRequest[] } {
  const requests: RpcRequest[] = [];
  const transport = new FakeTransport((request) => { requests.push(request); return handler(request); });
  return { client: new CoreClient("fake", 10_000, () => Promise.resolve({ transport })), requests };
}

/** 回放 core 的 job.* 应答：start→running 并登记 jobId 的 kind，status→给定终态，output 按 seq 分页 */
function jobHandler(output: (afterSeq: number, kind: string) => unknown, status: () => unknown = () => ({ state: "completed" })): Handler {
  const kinds = new Map<string, string>();
  return (request) => {
    const jobId = String(request.params.jobId);
    if (request.method === "core.ping") return pingInfo({ grepJob: true, globJob: true });
    if (request.method === "job.start") {
      kinds.set(jobId, String(request.params.kind));
      return { jobId, state: "running" };
    }
    if (request.method === "job.status") return { jobId, ...(status() as object) };
    if (request.method === "job.output") return output(Number(request.params.afterSeq), kinds.get(jobId) ?? "");
    throw new Error(`unexpected method ${request.method}`);
  };
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

let unitClient: CoreClient | undefined;

afterEach(async () => {
  await unitClient?.stop().catch(() => undefined);
  unitClient = undefined;
});

describe("CoreClient.searchJob (fake transport)", () => {
  it("glob/grep job：跨块 base64 JSONL 聚合为结果、summary.truncated 映射，不走同步回退", async () => {
    const texts: Record<string, string> = {
      glob: ['{"path":"a.ts"}', '{"path":"src/b.ts"}', '{"summary":{"entries":2,"truncated":true,"reason":"nodes"}}'].join("\n"),
      grep: ['{"path":"src/a.ts","line":2,"text":"const beta = 1;"}', '{"path":"src/b.ts","line":7,"text":"beta();"}', '{"summary":{"matches":2,"truncated":false,"reason":null}}'].join("\n"),
    };
    const { client, requests } = makeClient(jobHandler((afterSeq, kind) => {
      const text = texts[kind]!;
      const half = Math.floor(text.length / 2); // 首块在 JSON 行中间截断：跨页拼接必须还原完整行
      if (afterSeq === 0) return { chunks: [{ seq: 1, stream: "stdout", data: b64(text.slice(0, half)) }], nextSeq: 1, truncated: false };
      if (afterSeq === 1) return { chunks: [{ seq: 2, stream: "stdout", data: b64(text.slice(half)) }], nextSeq: 2, truncated: false };
      return { chunks: [], nextSeq: afterSeq, truncated: false };
    }));
    unitClient = client;
    await client.start();

    await expect(client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "glob", path: "src", pattern: "*.ts" }))
      .resolves.toEqual({ paths: ["a.ts", "src/b.ts"], truncated: true });
    expect(requests.find((request) => request.method === "job.start")?.params)
      .toEqual({ sessionId: "s1", jobId: expect.any(String), kind: "glob", cwd: "D:\\ws", path: "src", pattern: "*.ts" });
    await expect(client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "grep", path: ".", pattern: "beta" })).resolves.toEqual({
      matches: [{ path: "src/a.ts", line: 2, text: "const beta = 1;" }, { path: "src/b.ts", line: 7, text: "beta();" }],
      truncated: false,
    });
    expect(requests.some((request) => request.method === "fs.glob" || request.method === "fs.grep")).toBe(false);
  });

  it("失败路径显式报错：非 completed 终态带 state/error，core ring 溢出（truncated）不静默返回残缺结果", async () => {
    const failed = makeClient(jobHandler((afterSeq) => ({ chunks: [], nextSeq: afterSeq, truncated: false }), () => ({ state: "failed", error: "disk on fire" })));
    unitClient = failed.client;
    await failed.client.start();
    await expect(failed.client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "grep", path: ".", pattern: "x" })).rejects.toThrow("grep job failed: disk on fire");

    const overflow = makeClient(jobHandler((afterSeq) => ({ chunks: [], nextSeq: afterSeq, truncated: true })));
    unitClient = overflow.client;
    await overflow.client.start();
    await expect(overflow.client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "glob", path: ".", pattern: "*" })).rejects.toThrow("glob job output truncated by core ring buffer");
  });

  it("features 缺 grepJob/globJob 时回退同步 fs.glob/fs.grep；signal 中止先尽力 job.cancel 再抛错", async () => {
    const fallback = makeClient((request) => {
      if (request.method === "core.ping") return pingInfo();
      if (request.method === "fs.glob") return { paths: ["old.ts"], truncated: false };
      if (request.method === "fs.grep") return { matches: [{ path: "old.ts", line: 1, text: "beta" }], truncated: true };
      throw new Error(`unexpected method ${request.method}`);
    });
    unitClient = fallback.client;
    await fallback.client.start();
    await expect(fallback.client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "glob", path: ".", pattern: "*.ts" }))
      .resolves.toEqual({ paths: ["old.ts"], truncated: false });
    await expect(fallback.client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "grep", path: ".", pattern: "beta" }))
      .resolves.toEqual({ matches: [{ path: "old.ts", line: 1, text: "beta" }], truncated: true });
    expect(fallback.requests.some((request) => request.method === "job.start")).toBe(false);

    const abortable = makeClient(jobHandler((afterSeq) => ({ chunks: [], nextSeq: afterSeq, truncated: false }), () => ({ state: "running" })));
    unitClient = abortable.client;
    await abortable.client.start();
    const controller = new AbortController();
    controller.abort();
    await expect(abortable.client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "grep", path: ".", pattern: "x", signal: controller.signal }))
      .rejects.toThrow("grep job cancelled");
    // 取消的是同一个 job
    expect(abortable.requests.find((request) => request.method === "job.cancel")?.params.jobId)
      .toBe(abortable.requests.find((request) => request.method === "job.start")?.params.jobId);
  });
});

describe("CoreClient 生命周期与事件缓冲", () => {
  it("pty.output 在订阅者出现前被缓冲回放；stop 进行中与完成后 start 均拒绝", async () => {
    let transport: FakeTransport | undefined;
    const client = new CoreClient("fake", 10_000, () => {
      transport = new FakeTransport((request) => {
        if (request.method === "core.ping") return pingInfo();
        if (request.method === "core.shutdown") return { ok: true };
        throw new Error(request.method);
      });
      return Promise.resolve({ transport });
    });
    unitClient = client;
    await client.start();
    // pty.open 响应到达前 core 推送的 output：无订阅者先缓冲（shell banner 不丢失）
    transport!.emit("message", { jsonrpc: "2.0", method: "pty.output", params: { ptyId: 7, seq: 0, data: b64("banner$ ") } });
    const received: Array<{ data?: string }> = [];
    client.ptyEvents(7).on("output", (params: { data?: string }) => received.push(params));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(Buffer.from(received[0]!.data!, "base64").toString("utf8")).toBe("banner$ ");
    // stop() 同步置位 stopping：此时 start 不得重新武装（含自动重启），完成后仍拒绝
    const stopping = client.stop();
    await expect(client.start()).rejects.toThrow("stopping");
    await stopping;
    await expect(client.start()).rejects.toThrow("stopping");
  });
});
