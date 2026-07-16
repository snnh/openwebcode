import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, type CoreEvent } from "../src/core-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.resolve(here, "../../build/Debug/owc-exec.exe");
let client: CoreClient | undefined;

afterEach(async () => {
  await client?.stop();
  client = undefined;
});

describe("CoreClient", () => {
  it("handshakes and executes through the real core", async () => {
    client = new CoreClient(corePath);
    const events: CoreEvent[] = [];
    client.on("event", (event) => events.push(event));
    const info = await client.start();
    expect(info.platform).toBe("windows");

    const cwd = path.resolve(here, "../..");
    await client.configureSession({
      sessionId: "test-session",
      cwd,
      sandbox: {
        enabled: false,
        readRoots: [cwd],
        writeRoots: [cwd],
        denyPaths: [],
        network: "allow",
      },
    });
    const result = await client.run({
      sessionId: "test-session",
      execId: "test-exec",
      cmd: "Write-Output node-core-ok; [Console]::Error.WriteLine('node-core-error'); exit 7",
      cwd,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(7);
    const output = events.filter((event) => event.type === "exec.output");
    expect(output).toHaveLength(2);
  });
});
