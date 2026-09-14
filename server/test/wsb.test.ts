import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildWsbConfig, WsbManager } from "../src/sandbox/wsb.js";
import type { SessionMeta } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("buildWsbConfig", () => {
  it("LogonCommand 携带 --connect-token 回连令牌", () => {
    const config = buildWsbConfig({
      workspace: "D:\\dev\\demo",
      distDir: "D:\\dev\\openwebcode\\build\\Debug",
      hostIp: "192.168.1.10",
      port: 54321,
      connectToken: "a".repeat(64),
    });
    expect(config).toContain(`--connect 192.168.1.10:54321 --connect-token ${"a".repeat(64)}`);
  });
});

/** 读取一个 Content-Length 分帧的 RPC 请求，返回解析后的消息。 */
function readFrame(socket: Socket): Promise<{ id?: number; method?: string }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = buffer.subarray(0, separator).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isSafeInteger(length)) return reject(new Error("bad frame header"));
      const bodyStart = separator + 4;
      if (buffer.length < bodyStart + length) return;
      socket.removeListener("data", onData);
      resolve(JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")) as { id?: number; method?: string });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function writeFrame(socket: Socket, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}

describe("WSB 回连令牌握手（S7）", () => {
  it("无令牌/错误令牌的连接被丢弃，持令牌者完成握手", async () => {
    const root = await tempRoot("owc-wsb-");
    const wsbFiles: string[] = [];
    const fakeChild = new EventEmitter() as ChildProcess;
    const manager = new WsbManager({
      corePath: path.join(root, "owc-exec.exe"),
      sessionRootFor: (id) => path.join(root, id),
      connectTimeoutMs: 5_000,
      spawnWsb: (wsbPath) => { wsbFiles.push(wsbPath); return fakeChild; },
      pickHostIp: () => "127.0.0.1",
      detect: () => ({ available: true }),
    });
    const session = { id: "s1", cwd: "D:\\work", provider: "p", model: "m", title: "t", createdAt: "", updatedAt: "" } as SessionMeta;
    const clientPromise = manager.acquire("s1", session);
    // .wsb 落盘后取出端口与令牌
    await new Promise((resolve) => setTimeout(resolve, 100));
    const wsb = await readFile(wsbFiles[0]!, "utf8");
    const match = /--connect 127\.0\.0\.1:(\d+) --connect-token ([0-9a-f]{64})/.exec(wsb);
    expect(match).toBeTruthy();
    const port = Number(match![1]);
    const token = match![2]!;

    // 抢连者：无令牌/错令牌 → 连接被销毁，握手不受影响
    const attacker = connect(port, "127.0.0.1");
    attacker.write("wrong-token\n");
    await new Promise<void>((resolve) => { attacker.once("close", () => resolve()); attacker.once("error", () => resolve()); });

    // 合法 guest：上送令牌，应答 core.ping / core.shutdown
    const guest = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => guest.once("connect", resolve));
    guest.write(`${token}\n`);
    const ping = await readFrame(guest);
    expect(ping.method).toBe("core.ping");
    writeFrame(guest, { jsonrpc: "2.0", id: ping.id, result: { version: "1.10.5", platform: "windows", sandboxCapability: "enforced" } });

    const client = await clientPromise;
    expect(client).toBeTruthy();

    // 收尾：应答 shutdown 后释放
    const shutdownFrame = readFrame(guest);
    const releasePromise = manager.release("s1");
    const shutdown = await shutdownFrame;
    expect(shutdown.method).toBe("core.shutdown");
    writeFrame(guest, { jsonrpc: "2.0", id: shutdown.id, result: {} });
    await releasePromise;
    guest.destroy();
  });

  it("回连超时仍按原语义报错", async () => {
    const root = await tempRoot("owc-wsb-");
    const fakeChild = new EventEmitter() as ChildProcess;
    const manager = new WsbManager({
      corePath: path.join(root, "owc-exec.exe"),
      sessionRootFor: (id) => path.join(root, id),
      connectTimeoutMs: 200,
      spawnWsb: () => fakeChild,
      pickHostIp: () => "127.0.0.1",
      detect: () => ({ available: true }),
    });
    const session = { id: "s2", cwd: "D:\\work", provider: "p", model: "m", title: "t", createdAt: "", updatedAt: "" } as SessionMeta;
    await expect(manager.acquire("s2", session)).rejects.toThrow(/did not connect back/);
  });
});
