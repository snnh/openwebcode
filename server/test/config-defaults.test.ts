import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCorePath, loadConfig } from "../src/config.js";
import { SettingsService } from "../src/settings-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("defaultCorePath 平台感知", () => {
  it("Windows 为 MSVC 多配置布局，POSIX 为单配置布局", () => {
    expect(defaultCorePath("win32")).toBe("../build/Debug/owc-exec.exe");
    expect(defaultCorePath("linux")).toBe("../build/owc-exec");
    expect(defaultCorePath("darwin")).toBe("../build/owc-exec");
  });

  it("loadConfig 缺省按当前平台出默认值，OWC_CORE_PATH 优先", () => {
    expect(loadConfig({}).corePath).toBe(defaultCorePath());
    expect(loadConfig({ OWC_CORE_PATH: "/custom/owc-exec" }).corePath).toBe("/custom/owc-exec");
  });

  it("SettingsService 无覆盖时 effective/view 出当前平台默认", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-corepath-"));
    roots.push(root);
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    expect(settings.effective().corePath).toBe(defaultCorePath());
    const view = settings.view();
    const field = view.groups.flatMap((group) => group.fields).find((item) => item.key === "corePath");
    expect(field?.value).toBe(defaultCorePath());
  });

  it("SettingsService 文件覆盖优先于平台默认", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-corepath-"));
    roots.push(root);
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    await settings.update({ corePath: "/opt/owc/owc-exec" });
    expect(settings.effective().corePath).toBe("/opt/owc/owc-exec");
  });
});
