/**
 * dsh-sync M1b（官方扩展骨架 + 路由超时可配置化 + status 私有路由）单测。
 *
 * 覆盖三件事：
 * 1. {@link getDshSyncStatus} 的探测语义（配置指向 fixture 副本 / 不存在的目录 / 空配置）；
 * 2. {@link clampExtensionRouteTimeout} 的钳制边界（server 与 host 两侧共用同一函数）；
 * 3. `OFFICIAL_EXTENSIONS` 的 manifest.routes 与 host 侧 {@link dshSyncRoutes} 键集合一一对应（防漂移回归）。
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { dshSyncRoutes, getDshSyncStatus } from "../src/extensions/dsh-sync-host.js";
import { DSH_SYNC_DEFAULT_DSH_HOME, DSH_SYNC_DEFAULT_PROFILE } from "../src/extensions/dsh-sync-dsh.js";
import { OFFICIAL_DEFAULT_CONFIG, OFFICIAL_EXTENSIONS } from "../src/extensions/official.js";
import { clampExtensionRouteTimeout } from "../src/extensions/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-sync", import.meta.url));

/** 临时目录登记（afterAll 统一清理）。 */
const tempDirs: string[] = [];

/** 建临时目录（登记清理）。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("getDshSyncStatus", () => {
  it("配置指向 fixture 副本：目录/profile 存在，boolean 探测与 node 版本可用", async () => {
    const dshHome = path.join(await tempDir("owc-dsh-sync-status-"), "dsh-home");
    await cp(FIXTURES, dshHome, { recursive: true });
    const status = await getDshSyncStatus({ dshHome, profile: "web" });
    expect(status.dshHome).toBe(path.resolve(dshHome));
    expect(status.dshHomeExists).toBe(true);
    expect(status.profile).toBe("web");
    expect(status.profileExists).toBe(true);
    expect(status.nodeVersion).toBe(process.version);
    expect(typeof status.zstdAvailable).toBe("boolean");
    expect(typeof status.dshRunning).toBe("boolean");
  });

  it("配置指向不存在目录：两个 exists 均为 false，且不抛错", async () => {
    const dshHome = path.join(await tempDir("owc-dsh-sync-missing-"), "nope");
    const status = await getDshSyncStatus({ dshHome, profile: "web" });
    expect(status.dshHomeExists).toBe(false);
    expect(status.profileExists).toBe(false);
    expect(status.dshHome).toBe(path.resolve(dshHome));
  });

  it("profile 目录存在但 patch.yml 缺失：profileExists 为 false", async () => {
    const dshHome = path.join(await tempDir("owc-dsh-sync-empty-"), "dsh-home");
    await cp(FIXTURES, dshHome, { recursive: true });
    const status = await getDshSyncStatus({ dshHome, profile: "missing-profile" });
    expect(status.dshHomeExists).toBe(true);
    expect(status.profile).toBe("missing-profile");
    expect(status.profileExists).toBe(false);
  });

  it("空配置回落默认 ~/.dsh 与 web，不抛错", async () => {
    const status = await getDshSyncStatus({});
    expect(status.dshHome).toBe(path.join(os.homedir(), ".dsh"));
    expect(status.profile).toBe(DSH_SYNC_DEFAULT_PROFILE);
    expect(status.dshHome).toBe(path.resolve(DSH_SYNC_DEFAULT_DSH_HOME.replace("~", os.homedir())));
    expect(status.nodeVersion).toBe(process.version);
    expect(typeof status.dshHomeExists).toBe("boolean");
  });

  it("非字符串配置字段按缺省处理（不因类型错误抛错）", async () => {
    const status = await getDshSyncStatus({ dshHome: 42, profile: null });
    expect(status.dshHome).toBe(path.join(os.homedir(), ".dsh"));
    expect(status.profile).toBe(DSH_SYNC_DEFAULT_PROFILE);
  });

  it("GET /status 路由返回 200 与状态体", async () => {
    const dshHome = path.join(await tempDir("owc-dsh-sync-route-"), "dsh-home");
    await cp(FIXTURES, dshHome, { recursive: true });
    const handler = dshSyncRoutes.get("GET /status");
    expect(handler).toBeDefined();
    const response = await handler?.({ method: "GET", path: "/status", query: {} }, { dshHome, profile: "web" });
    expect(response?.status).toBe(200);
    const body = response?.body as { dshHome: string; dshHomeExists: boolean; profileExists: boolean };
    expect(body.dshHome).toBe(path.resolve(dshHome));
    expect(body.dshHomeExists).toBe(true);
    expect(body.profileExists).toBe(true);
  });
});

describe("clampExtensionRouteTimeout", () => {
  it("缺省与非数值回落 5000", () => {
    expect(clampExtensionRouteTimeout(undefined)).toBe(5000);
    expect(clampExtensionRouteTimeout("3000")).toBe(5000);
    expect(clampExtensionRouteTimeout(null)).toBe(5000);
    expect(clampExtensionRouteTimeout(Number.NaN)).toBe(5000);
    expect(clampExtensionRouteTimeout(1500.5)).toBe(5000);
  });

  it("下限 1000、上限 120000", () => {
    expect(clampExtensionRouteTimeout(500)).toBe(1000);
    expect(clampExtensionRouteTimeout(0)).toBe(1000);
    expect(clampExtensionRouteTimeout(-1)).toBe(1000);
    expect(clampExtensionRouteTimeout(999_999)).toBe(120_000);
  });

  it("合法值直通（含边界）", () => {
    expect(clampExtensionRouteTimeout(5000)).toBe(5000);
    expect(clampExtensionRouteTimeout(10_000)).toBe(10_000);
    expect(clampExtensionRouteTimeout(1000)).toBe(1000);
    expect(clampExtensionRouteTimeout(120_000)).toBe(120_000);
  });
});

describe("manifest.routes ↔ host 路由表一致性", () => {
  it("dsh-sync 的 manifest 路由与 dshSyncRoutes 键集合一一对应", () => {
    const manifest = OFFICIAL_EXTENSIONS.find((item) => item.id === "dsh-sync");
    expect(manifest).toBeDefined();
    const declared = (manifest?.routes ?? []).map((route) => `${route.method} ${route.path}`).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual([...dshSyncRoutes.keys()].sort());
  });

  it("manifest 声明了 http:route 权限、默认关闭，并有默认配置", () => {
    const manifest = OFFICIAL_EXTENSIONS.find((item) => item.id === "dsh-sync");
    expect(manifest?.permissions).toContain("http:route");
    expect(manifest?.official).toBe(true);
    expect(manifest?.defaultEnabled).toBe(false);
    expect(OFFICIAL_DEFAULT_CONFIG["dsh-sync"]).toEqual({ dshHome: "~/.dsh", profile: "web" });
    // status 路由需要 10s（750ms 端口探测 + 文件探测），必须高于缺省 5000
    expect(clampExtensionRouteTimeout(manifest?.routes?.[0]?.timeoutMs)).toBe(10_000);
  });

  it("每个 manifest 路由的 timeoutMs 都在钳制后落在合法区间", () => {
    for (const route of OFFICIAL_EXTENSIONS.flatMap((item) => item.routes ?? [])) {
      const timeoutMs = clampExtensionRouteTimeout(route.timeoutMs);
      expect(timeoutMs).toBeGreaterThanOrEqual(1000);
      expect(timeoutMs).toBeLessThanOrEqual(120_000);
    }
  });
});
