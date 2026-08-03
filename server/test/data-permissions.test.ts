import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirWithMode } from "../src/fs-utils.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { SettingsService } from "../src/settings-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-perms-"));
  roots.push(root);
  return root;
}

const modeOf = async (target: string): Promise<number> => (await stat(target)).mode & 0o777;

// 权限位断言仅 POSIX 有意义；Windows 上这些调用一律 no-op，由其余用例覆盖功能路径。
describe.skipIf(process.platform === "win32")("数据目录与敏感文件权限（POSIX）", () => {
  it("ensureDirWithMode 创建并收紧目录为 0700", async () => {
    const root = await makeRoot();
    const dir = path.join(root, "nested", "data");
    await ensureDirWithMode(dir, 0o700);
    expect(await modeOf(dir)).toBe(0o700);
  });

  it("sessions 根目录 0700；会话目录 0700；meta.json/messages.jsonl 0600", async () => {
    const root = await makeRoot();
    const sessionsRoot = path.join(root, "sessions");
    const store = new SessionStore(sessionsRoot);
    await store.initialize();
    expect(await modeOf(sessionsRoot)).toBe(0o700);
    const meta = await store.create({ cwd: root });
    expect(await modeOf(path.join(sessionsRoot, meta.id))).toBe(0o700);
    expect(await modeOf(path.join(sessionsRoot, meta.id, "meta.json"))).toBe(0o600);
    expect(await modeOf(path.join(sessionsRoot, meta.id, "messages.jsonl"))).toBe(0o600);
  });

  it("server-settings.json 0600，所在目录 0700", async () => {
    const root = await makeRoot();
    const dir = path.join(root, "settings-dir");
    const settings = await SettingsService.load({ env: {}, filePath: path.join(dir, "server-settings.json") });
    await settings.update({ port: 4321 });
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(path.join(dir, "server-settings.json"))).toBe(0o600);
  });

  it("provider-profiles.json 0600，所在目录 0700", async () => {
    const root = await makeRoot();
    const dir = path.join(root, "profiles-dir");
    const profiles = await ProviderProfilesService.load({ filePath: path.join(dir, "provider-profiles.json") });
    await profiles.upsertWeb(undefined, { id: "tavily-main", provider: "tavily", apiKey: "tvly-test-key" });
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(path.join(dir, "provider-profiles.json"))).toBe(0o600);
  });
});

describe("ensureDirWithMode Windows no-op", () => {
  it("win32 平台只建目录，不尝试 chmod", async () => {
    const root = await makeRoot();
    const dir = path.join(root, "data");
    await ensureDirWithMode(dir, 0o700, "win32");
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});
