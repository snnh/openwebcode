import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, type CoreEvent } from "../src/core-client.js";

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

describe.skipIf(!existsSync(corePath))("CoreClient", () => {
  it("handshakes and executes through the real core", async () => {
    client = new CoreClient(corePath);
    const events: CoreEvent[] = [];
    client.on("event", (event) => events.push(event));
    const info = await client.start();
    expect(["windows", "linux", "darwin"]).toContain(info.platform);

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
      cmd: process.platform === "win32"
        ? "Write-Output node-core-ok; [Console]::Error.WriteLine('node-core-error'); exit 7"
        : "printf 'node-core-ok\\n'; printf 'node-core-error\\n' >&2; exit 7",
      cwd,
      timeoutMs: 15_000,
      shellBackend: process.platform === "win32" ? "pwsh" : "default",
    });
    expect(result.exitCode).toBe(7);
    const output = events.filter((event) => event.type === "exec.output");
    expect(output).toHaveLength(2);

    if (process.platform === "win32") {
      const hostedWindows = process.env.GITHUB_ACTIONS?.toLowerCase() === "true";
      await client.configureSession({
        sessionId: "test-session",
        cwd,
        sandbox: {
          enabled: true,
          readRoots: [cwd],
          writeRoots: [cwd],
          denyPaths: [],
          network: "deny",
        },
      });
      const directoryResult = await client.run({
        sessionId: "test-session",
        execId: hostedWindows ? "test-cmd-directory" : "test-pwsh-directory",
        // GitHub-hosted Windows runners retain/fail AppContainer pwsh children
        // inconsistently. Non-sandbox pwsh is covered above; keep the hosted
        // sandbox integration on cmd and exercise sandbox+pwsh locally.
        cmd: hostedWindows
          ? "dir /b >nul"
          : "Get-ChildItem -Name | Select-Object -First 1",
        cwd,
        timeoutMs: 15_000,
        shellBackend: hostedWindows ? "default" : "pwsh",
      });
      expect(directoryResult.exitCode).toBe(0);
      await expect(client.ping()).resolves.toMatchObject({ platform: "windows" });
    }
  }, 30_000);
});
