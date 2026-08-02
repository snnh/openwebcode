import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { IndexManager } from "../src/index/index-manager.js";
import { tempRoot } from "./helpers/temp-roots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);

let client: CoreClient | undefined;
let manager: IndexManager | undefined;

afterEach(async () => {
  manager?.stop();
  manager = undefined;
  await client?.stop().catch(() => undefined);
  client = undefined;
});

describe.skipIf(!existsSync(corePath))("IndexManager against real core (base64 job.output)", () => {
  it("runs a real index.scan + index.extract and finds files and symbols", async () => {
    const workspace = await tempRoot("owc-index-e2e-ws-");
    const indexRoot = await tempRoot("owc-index-e2e-idx-");
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "util.ts"), "export function helperFn(): number {\n  return 1;\n}\n");
    writeFileSync(path.join(workspace, "src", "main.ts"), "export const betaValue = 2;\n");

    client = new CoreClient(corePath);
    const info = await client.start();
    expect(info.features?.indexScan).toBe(true);
    expect(info.features?.indexExtract).toBe(true);
    await client.configureSession({
      sessionId: "index-e2e",
      cwd: workspace,
      sandbox: { enabled: false, readRoots: [workspace], writeRoots: [workspace], denyPaths: [], network: "allow" },
    });

    manager = new IndexManager(client, indexRoot, new EventBus(), { pollMs: 20, autoRefresh: false });
    await manager.rebuild("index-e2e", workspace);
    let status = await manager.status("index-e2e", workspace);
    for (let attempt = 0; status.status === "building" && attempt < 400; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await manager.status("index-e2e", workspace);
    }
    // base64 解码回归：修复前这里会因 JSONL 解析出 base64 垃圾而 error/stale
    expect(status.status).toBe("fresh");
    expect(status.files).toBe(2);

    const symbols = await manager.searchSymbols(workspace, "helperFn");
    expect(symbols.some((hit) => hit.path === "src/util.ts" && hit.kind === "function")).toBe(true);

    const files = await manager.searchFiles(workspace, "main");
    expect(files.some((hit) => hit.path === "src/main.ts")).toBe(true);
  }, 30_000);
});
