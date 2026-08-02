import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, CoreRpcError } from "../src/core-client.js";
import { tempRoot } from "./helpers/temp-roots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);
let client: CoreClient | undefined;

afterEach(async () => {
  await client?.stop();
  client = undefined;
});

describe.skipIf(!existsSync(corePath))("CoreClient fs.readBase64", () => {
  async function start(): Promise<{ cwd: string }> {
    const cwd = await tempRoot("owc-read-base64-");
    client = new CoreClient(corePath);
    const info = await client.start();
    // 六方同步面：新 core 必须上报 fs.readBase64 能力与读取上限
    expect(info.features?.fsReadBase64).toBe(true);
    expect(info.limits?.maxReadBase64Bytes).toBe(20 * 1024 * 1024);
    await client.configureSession({
      sessionId: "test-session",
      cwd,
      sandbox: { enabled: false, readRoots: [cwd], writeRoots: [cwd], denyPaths: [], network: "allow" },
    });
    return { cwd };
  }

  it("roundtrips binary bytes including NUL and 0xFF", async () => {
    const { cwd } = await start();
    const blob = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0x00, 0xff, 0xfe, 0x00])]);
    await writeFile(path.join(cwd, "blob.bin"), blob);
    const result = await client!.readFileBase64!({ sessionId: "test-session", path: "blob.bin" });
    expect(result.truncated).toBe(false);
    expect(result.size).toBe(blob.length);
    expect(Buffer.from(result.base64, "base64")).toEqual(blob);
  });

  it("roundtrips through writeFileBase64", async () => {
    await start();
    const blob = Buffer.from("pretend-png-bytes\x00\x89PNG", "binary");
    await client!.writeFileBase64!({ sessionId: "test-session", path: "image.png", data: blob.toString("base64") });
    const result = await client!.readFileBase64!({ sessionId: "test-session", path: "image.png" });
    expect(result.truncated).toBe(false);
    expect(Buffer.from(result.base64, "base64")).toEqual(blob);
  });

  it("maps a missing file to the stable -32003 error", async () => {
    await start();
    const failure = await client!.readFileBase64!({ sessionId: "test-session", path: "missing.bin" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreRpcError);
    expect((failure as CoreRpcError).code).toBe(-32003);
  });
});
