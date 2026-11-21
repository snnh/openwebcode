// dsh 兼容模式前端同步单测：未就绪提示、设置读取、入口 URL、store 同步。
import { describe, expect, it } from "vitest";
import { DEFAULT_DSH_PORT, dshEntryUrl, dshNotReadyNotice, readDshMode } from "../app/dsh-mode-sync";
import { ui, uiStore } from "../app/ui-store";
import type { SettingsView } from "../lib/contracts";
const field = (key: string, value: unknown, type: "boolean" | "number" = "boolean") =>
  ({ key, label: key, type, value, hasValue: value !== null, source: "file", editable: true, restartRequired: false, nullable: false });
const settingsView = (fields: unknown[]): SettingsView => ({ groups: [{ id: "general", label: "通用", fields }] }) as unknown as SettingsView;
describe("dsh 兼容模式前端同步", () => {
  it("未就绪提示给出具体处置；readDshMode 未加载/缺字段返回 undefined、端口越界回落默认", () => {
    expect(dshNotReadyNotice("vendor missing", 3211).zh).toContain("fetch-dsh-web.mjs"); expect(dshNotReadyNotice("non-loopback without access token", 3211).zh).toContain("OWC_ACCESS_TOKEN");
    expect(dshNotReadyNotice("listen EADDRINUSE", 4000).zh).toContain("EADDRINUSE"); expect(dshNotReadyNotice(undefined, 4000).zh).toContain("4000");
    expect(readDshMode(undefined)).toBeUndefined(); expect(readDshMode(settingsView([field("dshPort", 3211, "number")]))).toBeUndefined();
    expect(readDshMode(settingsView([field("dshCompatEnabled", true)]))).toEqual({ enabled: true, port: DEFAULT_DSH_PORT });
    expect(readDshMode(settingsView([field("dshCompatEnabled", true), field("dshPort", 4000, "number")]))).toEqual({ enabled: true, port: 4000 });
    expect(readDshMode(settingsView([field("dshCompatEnabled", true), field("dshPort", 80, "number")]))).toEqual({ enabled: true, port: DEFAULT_DSH_PORT });
    expect(readDshMode(settingsView([field("dshCompatEnabled", "yes")]))).toEqual({ enabled: false, port: DEFAULT_DSH_PORT });
  });
  it("dshEntryUrl：同 hostname 换端口；带 token 转发，不带 token 不拼查询串。ui-store 同步写入 enabled/port", () => {
    expect(dshEntryUrl({ enabled: true, port: 3211 }, { protocol: "http:", hostname: "192.168.1.5", search: "" })).toBe("http://192.168.1.5:3211/");
    expect(dshEntryUrl({ enabled: true, port: 4321 }, { protocol: "https:", hostname: "owc.local", search: "?token=abc%2Fdef" })).toBe("https://owc.local:4321/?token=abc%2Fdef");
    expect(dshEntryUrl({ enabled: true, port: 3211 }, { protocol: "http:", hostname: "127.0.0.1", search: "?token=" })).toBe("http://127.0.0.1:3211/");
    expect(uiStore.get().dshCompat).toEqual({ enabled: false, port: DEFAULT_DSH_PORT });
    ui.setDshCompat({ enabled: true, port: 4000 }); expect(uiStore.get().dshCompat).toEqual({ enabled: true, port: 4000 });
    ui.setDshCompat({ enabled: false, port: DEFAULT_DSH_PORT }); expect(uiStore.get().dshCompat.enabled).toBe(false);
  });
});
