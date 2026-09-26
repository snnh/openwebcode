import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../src/rpc/frame-codec.js";
import { buildWsbConfig, WsbManager } from "../src/sandbox/wsb.js";
import type { SessionMeta } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 等待 socket 上下一帧 JSON-RPC 消息（Content-Length 分帧）。 */
function readFrame(socket: Socket): Promise<{ id?: number; method?: string }> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const onData = (chunk: Buffer): void => decoder.push(chunk);
    decoder.on("message", (message) => {
      socket.removeListener("data", onData);
      resolve(message as { id?: number; method?: string });
    });
    decoder.on("error", reject);
    socket.on("data", onData);
  });
}

const writeFrame = (socket: Socket, message: unknown): void => { socket.write(encodeFrame(message)); };

/** 不真起 wsb.exe 的 WsbManager：spawnWsb 只收集生成的 .wsb 路径并回一个假子进程。 */
function makeManager(root: string, connectTimeoutMs: number, wsbFiles: string[] = []): WsbManager {
  const child = new EventEmitter() as ChildProcess;
  return new WsbManager({
    corePath: path.join(root, "owc-exec.exe"), connectTimeoutMs,
    sessionRootFor: (id) => path.join(root, id), spawnWsb: (wsbPath) => { wsbFiles.push(wsbPath); return child; },
    pickHostIp: () => "127.0.0.1", detect: () => ({ available: true }),
  });
}

const session = (id: string): SessionMeta => ({ id, cwd: "D:\\work", provider: "p", model: "m", title: "t", createdAt: "", updatedAt: "" }) as SessionMeta;

describe("WSB 回连令牌握手（S7）", () => {
  it("LogonCommand 携带 --connect-token 回连令牌", () => {
    const connectToken = "a".repeat(64);
    const config = buildWsbConfig({ workspace: "D:\\dev\\demo", distDir: "D:\\dev\\openwebcode\\build\\Debug", hostIp: "192.168.1.10", port: 54321, connectToken });
    expect(config).toContain(`--connect 192.168.1.10:54321 --connect-token ${connectToken}`);
  });

  it("无令牌/错误令牌的连接被丢弃，持令牌者完成握手；未回连超时仍按原语义报错", async () => {
    const root = await tempRoot("owc-wsb-");
    const wsbFiles: string[] = [];
    const manager = makeManager(root, 5_000, wsbFiles);
    const clientPromise = manager.acquire("s1", session("s1"));
    while (wsbFiles.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const match = /--connect 127\.0\.0\.1:(\d+) --connect-token ([0-9a-f]{64})/.exec(await readFile(wsbFiles[0]!, "utf8"));
    expect(match).toBeTruthy();
    const port = Number(match![1]), token = match![2]!;

    const attacker = connect(port, "127.0.0.1");
    attacker.write("wrong-token\n");
    await new Promise<void>((resolve) => { attacker.once("close", () => resolve()); attacker.once("error", () => resolve()); });

    const guest = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => guest.once("connect", resolve));
    guest.write(`${token}\n`);
    const ping = await readFrame(guest);
    expect(ping.method).toBe("core.ping");
    writeFrame(guest, { jsonrpc: "2.0", id: ping.id, result: { version: "1.10.5", platform: "windows", sandboxCapability: "enforced" } });
    expect(await clientPromise).toBeTruthy();

    const shutdownFrame = readFrame(guest);
    const releasePromise = manager.release("s1");
    const shutdown = await shutdownFrame;
    expect(shutdown.method).toBe("core.shutdown");
    writeFrame(guest, { jsonrpc: "2.0", id: shutdown.id, result: {} });
    await releasePromise;
    guest.destroy();

    await expect(makeManager(root, 200).acquire("s2", session("s2"))).rejects.toThrow(/did not connect back/);
  }, 20_000);
});
