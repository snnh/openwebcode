import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreClient, type CoreInfo } from "../src/core-client.js";
import { RpcTransport } from "../src/rpc/transport.js";
import { tempRoot } from "./helpers/temp-roots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);

// ---------- fake transport 单测：回放 core.ping + job.* 序列 ----------

interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> }
type Handler = (request: RpcRequest) => unknown;

/** 内存 RpcTransport：write 按 id 异步回包，配合 CoreClient 的 connectionFactory 注入。 */
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

function pingInfo(features: Record<string, boolean> = {}): CoreInfo {
  return {
    version: "test",
    protocolVersion: "1.0",
    platform: "windows",
    sandboxCapability: "advisory",
    features: {
      fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: true,
      fsHash: true, fsScanPagination: true, fsWatch: true, ...features,
    },
  };
}

function makeClient(handler: Handler): { client: CoreClient; requests: RpcRequest[] } {
  const requests: RpcRequest[] = [];
  const transport = new FakeTransport((request) => {
    requests.push(request);
    return handler(request);
  });
  const client = new CoreClient("fake", 10_000, () => Promise.resolve({ transport }));
  return { client, requests };
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

let unitClient: CoreClient | undefined;

afterEach(async () => {
  await unitClient?.stop().catch(() => undefined);
  unitClient = undefined;
});

describe("CoreClient.searchJob (fake transport)", () => {
  it("glob job：启动 -> 分页聚合 base64 JSONL（跨块断行） -> 解析为 FsGlobResult，summary.truncated 映射", async () => {
    const { client, requests } = makeClient((request) => {
      if (request.method === "core.ping") return pingInfo({ grepJob: true, globJob: true });
      if (request.method === "job.start") return { jobId: request.params.jobId, state: "running" };
      if (request.method === "job.status") return { jobId: request.params.jobId, state: "completed" };
      if (request.method === "job.output") {
        const afterSeq = Number(request.params.afterSeq);
        if (afterSeq === 0) return { chunks: [{ seq: 1, stream: "stdout", data: b64('{"path":"a.ts"}\n{"path":"src/b') }], nextSeq: 1, truncated: false };
        if (afterSeq === 1) return { chunks: [{ seq: 2, stream: "stdout", data: b64('.ts"}\n{"summary":{"entries":2,"truncated":true,"reason":"nodes"}}\n') }], nextSeq: 2, truncated: false };
        return { chunks: [], nextSeq: afterSeq, truncated: false };
      }
      throw new Error(`unexpected method ${request.method}`);
    });
    unitClient = client;
    await client.start();

    const result = await client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "glob", path: "src", pattern: "*.ts" });
    expect(result).toEqual({ paths: ["a.ts", "src/b.ts"], truncated: true });

    const start = requests.find((request) => request.method === "job.start");
    expect(start?.params).toEqual({ sessionId: "s1", jobId: expect.any(String), kind: "glob", cwd: "D:\\ws", path: "src", pattern: "*.ts" });
    // 同步回退未被使用
    expect(requests.some((request) => request.method === "fs.glob")).toBe(false);
  });

  it("grep job：聚合匹配行（path/line/text），summary.truncated=false 映射", async () => {
    const jsonl = [
      '{"path":"src/a.ts","line":2,"text":"const beta = 1;"}',
      '{"path":"src/b.ts","line":7,"text":"beta();"}',
      '{"summary":{"matches":2,"truncated":false,"reason":null}}',
      "",
    ].join("\n");
    const { client } = makeClient((request) => {
      if (request.method === "core.ping") return pingInfo({ grepJob: true, globJob: true });
      if (request.method === "job.start") return { jobId: request.params.jobId, state: "running" };
      if (request.method === "job.status") return { jobId: request.params.jobId, state: "completed" };
      if (request.method === "job.output") {
        const afterSeq = Number(request.params.afterSeq);
        if (afterSeq === 0) return { chunks: [{ seq: 1, stream: "stdout", data: b64(jsonl) }], nextSeq: 1, truncated: false };
        return { chunks: [], nextSeq: afterSeq, truncated: false };
      }
      throw new Error(`unexpected method ${request.method}`);
    });
    unitClient = client;
    await client.start();

    const result = await client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "grep", path: ".", pattern: "beta" });
    expect(result).toEqual({
      matches: [
        { path: "src/a.ts", line: 2, text: "const beta = 1;" },
        { path: "src/b.ts", line: 7, text: "beta();" },
      ],
      truncated: false,
    });
  });

  it("job 非 completed 终态：抛出带 state 与 error 的错误（与同步路径同语义地失败）", async () => {
    const { client } = makeClient((request) => {
      if (request.method === "core.ping") return pingInfo({ grepJob: true, globJob: true });
      if (request.method === "job.start") return { jobId: request.params.jobId, state: "running" };
      if (request.method === "job.status") return { jobId: request.params.jobId, state: "failed", error: "disk on fire" };
      if (request.method === "job.output") return { chunks: [], nextSeq: Number(request.params.afterSeq), truncated: false };
      throw new Error(`unexpected method ${request.method}`);
    });
    unitClient = client;
    await client.start();

    await expect(client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "grep", path: ".", pattern: "x" }))
      .rejects.toThrow("grep job failed: disk on fire");
  });

  it("core 输出 ring 溢出（job.output truncated）：显式失败而非静默残缺", async () => {
    const { client } = makeClient((request) => {
      if (request.method === "core.ping") return pingInfo({ grepJob: true, globJob: true });
      if (request.method === "job.start") return { jobId: request.params.jobId, state: "running" };
      if (request.method === "job.status") return { jobId: request.params.jobId, state: "completed" };
      if (request.method === "job.output") return { chunks: [], nextSeq: Number(request.params.afterSeq), truncated: true };
      throw new Error(`unexpected method ${request.method}`);
    });
    unitClient = client;
    await client.start();

    await expect(client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "glob", path: ".", pattern: "*" }))
      .rejects.toThrow("glob job output truncated by core ring buffer");
  });

  it("features 缺 grepJob/globJob：回退同步 fs.glob/fs.grep，不发 job.start", async () => {
    const { client, requests } = makeClient((request) => {
      if (request.method === "core.ping") return pingInfo();
      if (request.method === "fs.glob") return { paths: ["old.ts"], truncated: false };
      if (request.method === "fs.grep") return { matches: [{ path: "old.ts", line: 1, text: "beta" }], truncated: true };
      throw new Error(`unexpected method ${request.method}`);
    });
    unitClient = client;
    await client.start();

    await expect(client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "glob", path: ".", pattern: "*.ts" }))
      .resolves.toEqual({ paths: ["old.ts"], truncated: false });
    await expect(client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "grep", path: ".", pattern: "beta" }))
      .resolves.toEqual({ matches: [{ path: "old.ts", line: 1, text: "beta" }], truncated: true });
    expect(requests.some((request) => request.method === "job.start")).toBe(false);
  });

  it("signal 中止：尽力 job.cancel 后抛错", async () => {
    const { client, requests } = makeClient((request) => {
      if (request.method === "core.ping") return pingInfo({ grepJob: true, globJob: true });
      if (request.method === "job.start") return { jobId: request.params.jobId, state: "running" };
      if (request.method === "job.cancel") return { jobId: request.params.jobId, accepted: true };
      if (request.method === "job.status") return { jobId: request.params.jobId, state: "running" };
      if (request.method === "job.output") return { chunks: [], nextSeq: Number(request.params.afterSeq), truncated: false };
      throw new Error(`unexpected method ${request.method}`);
    });
    unitClient = client;
    await client.start();

    const controller = new AbortController();
    controller.abort();
    await expect(client.searchJob({ sessionId: "s1", cwd: "D:\\ws", kind: "grep", path: ".", pattern: "x", signal: controller.signal }))
      .rejects.toThrow("grep job cancelled");
    const start = requests.find((request) => request.method === "job.start");
    const cancel = requests.find((request) => request.method === "job.cancel");
    expect(cancel?.params.jobId).toBe(start?.params.jobId);
  });
});

// ---------- pty 事件缓冲回放与 start/stop 状态机（fake transport） ----------

describe("CoreClient ptyEvents 缓冲回放", () => {
  it("首个 on(\"output\") 能收到注册前缓冲的 pty.output（shell banner 不丢失）", async () => {
    let transport: FakeTransport | undefined;
    const client = new CoreClient("fake", 10_000, () => {
      transport = new FakeTransport((request) => {
        if (request.method === "core.ping") return pingInfo();
        throw new Error(`unexpected method ${request.method}`);
      });
      return Promise.resolve({ transport });
    });
    unitClient = client;
    await client.start();
    // pty.open 响应到达前 core 推送的 output：无订阅者先缓冲（pendingPtyEvents）
    transport!.emit("message", { jsonrpc: "2.0", method: "pty.output", params: { ptyId: 7, seq: 0, data: b64("banner$ ") } });
    const received: Array<{ ptyId?: number; data?: string }> = [];
    client.ptyEvents(7).on("output", (params: { ptyId?: number; data?: string }) => received.push(params));
    // 首个 listener 注册后经微任务回放，缓冲事件必然送达
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(Buffer.from(received[0]!.data!, "base64").toString("utf8")).toBe("banner$ ");
  });
});

describe("CoreClient start/stop 竞态", () => {
  it("stop 进行中与完成后 start 均拒绝，不再复位 stopping", async () => {
    const { client } = makeClient((request) => {
      if (request.method === "core.ping") return pingInfo();
      if (request.method === "core.shutdown") return { ok: true };
      throw new Error(`unexpected method ${request.method}`);
    });
    unitClient = client;
    await client.start();
    const stopping = client.stop();
    // stop() 同步置位 stopping；此时 start 不得重新武装（含自动重启）
    await expect(client.start()).rejects.toThrow("stopping");
    await stopping;
    await expect(client.start()).rejects.toThrow("stopping");
  });
});

// ---------- 真实 core 端到端：job 路径与同步路径结果一致 ----------
describe.skipIf(!existsSync(corePath))("CoreClient.searchJob (real core)", () => {
  let client: CoreClient | undefined;

  afterEach(async () => {
    await client?.stop().catch(() => undefined);
    client = undefined;
  });

  it("grep/glob job 与同步 fs.grep/fs.glob 返回同形结果", async () => {
    client = new CoreClient(corePath);
    const info = await client.start();
    expect(info.features?.grepJob).toBe(true);
    expect(info.features?.globJob).toBe(true);

    const workspace = await tempRoot("owc-search-job-client-");
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "main.ts"), "export const main = 1;\nconst beta = 2;\n");
    writeFileSync(path.join(workspace, "src", "util.ts"), "export const util = 2;\nconst beta = 3;\n");
    writeFileSync(path.join(workspace, "docs.md"), "# guide\nbeta reference\n");
    await client.configureSession({
      sessionId: "search-client-session",
      cwd: workspace,
      sandbox: { enabled: false, readRoots: [workspace], writeRoots: [workspace], denyPaths: [], network: "allow" },
    });

    const jobGlob = await client.searchJob({ sessionId: "search-client-session", cwd: workspace, kind: "glob", path: ".", pattern: "*.md" });
    const syncGlob = await client.globFiles({ sessionId: "search-client-session", path: ".", pattern: "*.md" });
    expect([...jobGlob.paths].sort()).toEqual([...syncGlob.paths].sort());
    expect(jobGlob.paths).toEqual(["docs.md"]);
    expect(jobGlob.truncated).toBe(false);

    const jobGrep = await client.searchJob({ sessionId: "search-client-session", cwd: workspace, kind: "grep", path: ".", pattern: "beta" });
    const syncGrep = await client.grepFiles({ sessionId: "search-client-session", path: ".", pattern: "beta" });
    const key = (match: { path: string; line: number; text: string }): string => `${match.path}:${match.line}:${match.text}`;
    expect(jobGrep.matches.map(key).sort()).toEqual(syncGrep.matches.map(key).sort());
    expect(jobGrep.matches.length).toBe(3);
    expect(jobGrep.truncated).toBe(false);
    // job 结果按 path/line 确定性排序
    expect(jobGrep.matches.map((match) => match.path)).toEqual(["docs.md", "src/main.ts", "src/util.ts"]);
  }, 30_000);
});
