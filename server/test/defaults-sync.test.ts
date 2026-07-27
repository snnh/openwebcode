import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import installDefaultsDocument from "../src/config/defaults.json" with { type: "json" };
import { CODE_DEFAULTS, SettingsService, type SettingsFieldView, type SettingsView } from "../src/settings-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function field(view: SettingsView, key: string): SettingsFieldView {
  for (const group of view.groups) {
    const found = group.fields.find((item) => item.key === key);
    if (found) return found;
  }
  throw new Error(`Field ${key} not found`);
}

describe("install-dir defaults sync guard", () => {
  it("config/defaults.json covers exactly the FIELDS keys with matching values", () => {
    const fileDefaults = installDefaultsDocument as Record<string, unknown>;
    const fileKeys = Object.keys(fileDefaults).sort();
    const codeKeys = [...CODE_DEFAULTS.keys()].sort();
    expect(fileKeys).toEqual(codeKeys);
    for (const key of codeKeys) {
      expect(fileDefaults[key], `default mismatch for ${key}`).toEqual(CODE_DEFAULTS.get(key));
    }
  });
});

describe("settings auto-combine (install default + user override)", () => {
  it("serves install defaults when nothing is overridden", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-defaults-"));
    roots.push(root);
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    const view = settings.view();
    const port = field(view, "port");
    expect(port.source).toBe("default");
    expect(port.value).toBe(port.installDefault);
    expect(port.installDefault).toBe(3210);
  });

  it("keeps the user override and exposes the differing install default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-defaults-"));
    roots.push(root);
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    await settings.update({ port: 9999 });
    const view = settings.view();
    const port = field(view, "port");
    expect(port.source).toBe("file");
    expect(port.value).toBe(9999);
    expect(port.installDefault).toBe(3210);
  });

  it("writing the install default clears the override (adopt new default)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-defaults-"));
    roots.push(root);
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    await settings.update({ port: 9999 });
    await settings.update({ port: 3210 });
    const port = field(settings.view(), "port");
    expect(port.source).toBe("default");
    expect(port.value).toBe(3210);
  });
});
