/** dsh 兼容模式前端同步单测（M4 步骤 17）：设置读取、入口 URL、store 同步。 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DSH_PORT, dshEntryUrl, readDshMode } from "../app/dsh-mode-sync";
import { ui, uiStore } from "../app/ui-store";
import type { SettingsView } from "../lib/contracts";

function booleanField(key: string, value: unknown) {
  return { key, label: key, type: "boolean" as const, value, hasValue: value !== null, source: "file" as const, editable: true, restartRequired: false, nullable: false };
}

function numberField(key: string, value: unknown) {
  return { key, label: key, type: "number" as const, value, hasValue: value !== null, source: "file" as const, editable: true, restartRequired: false, nullable: false };
}

function settingsView(fields: unknown[]): SettingsView {
  return { groups: [{ id: "general", label: "通用", fields }] } as unknown as SettingsView;
}

describe("dsh 兼容模式前端同步", () => {
  it("readDshMode：未加载或缺字段返回 undefined；端口越界回落默认", () => {
    expect(readDshMode(undefined)).toBeUndefined();
    expect(readDshMode(settingsView([numberField("dshPort", 3211)]))).toBeUndefined();
    expect(readDshMode(settingsView([booleanField("dshCompatEnabled", true)]))).toEqual({ enabled: true, port: DEFAULT_DSH_PORT });
    expect(readDshMode(settingsView([booleanField("dshCompatEnabled", true), numberField("dshPort", 4000)]))).toEqual({ enabled: true, port: 4000 });
    expect(readDshMode(settingsView([booleanField("dshCompatEnabled", true), numberField("dshPort", 80)]))).toEqual({ enabled: true, port: DEFAULT_DSH_PORT });
    expect(readDshMode(settingsView([booleanField("dshCompatEnabled", "yes")]))).toEqual({ enabled: false, port: DEFAULT_DSH_PORT });
  });

  it("dshEntryUrl：同 hostname 换端口；带 token 时转发，不带 token 时不拼查询串", () => {
    expect(dshEntryUrl({ enabled: true, port: 3211 }, { protocol: "http:", hostname: "192.168.1.5", search: "" })).toBe("http://192.168.1.5:3211/");
    expect(dshEntryUrl({ enabled: true, port: 4321 }, { protocol: "https:", hostname: "owc.local", search: "?token=abc%2Fdef" })).toBe("https://owc.local:4321/?token=abc%2Fdef");
    expect(dshEntryUrl({ enabled: true, port: 3211 }, { protocol: "http:", hostname: "127.0.0.1", search: "?token=" })).toBe("http://127.0.0.1:3211/");
  });

  it("ui-store 同步：setDshCompat 写入 enabled/port，默认关闭", () => {
    expect(uiStore.get().dshCompat).toEqual({ enabled: false, port: DEFAULT_DSH_PORT });
    ui.setDshCompat({ enabled: true, port: 4000 });
    expect(uiStore.get().dshCompat).toEqual({ enabled: true, port: 4000 });
    ui.setDshCompat({ enabled: false, port: DEFAULT_DSH_PORT });
    expect(uiStore.get().dshCompat.enabled).toBe(false);
  });
});
