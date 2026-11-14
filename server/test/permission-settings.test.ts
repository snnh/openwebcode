import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsService } from "../src/settings-service.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function load(env: Record<string, string> = {}) {
  const root = await tempRoot("owc-permission-settings-");
  return SettingsService.load({ env, filePath: path.join(root, "server-settings.json") });
}

describe("全局权限设置", () => {
  it("环境变量解析为全局规则与追加高危项", async () => {
    const settings = await load({
      OWC_PERMISSION_GLOBAL_RULES: "bash|git status\nweb_fetch|https://docs.example.com\nread_file",
      OWC_PERMISSION_HIGH_RISK_COMMANDS: "terraform apply\ndocker system prune",
      OWC_PERMISSION_HIGH_RISK_TOOLS: "mcp__prod__deploy",
    });
    const effective = settings.effective();
    expect(effective.permissionGlobalRules).toEqual([
      { tool: "bash", argumentPrefix: "git status" },
      { tool: "web_fetch", argumentPrefix: "https://docs.example.com" },
      { tool: "read_file" },
    ]);
    expect(effective.permissionHighRisk).toEqual({
      commands: ["terraform apply", "docker system prune"],
      tools: ["mcp__prod__deploy"],
    });
  });

  it("保存时拒绝非法工具名与超长前缀；合法规则热生效", async () => {
    const settings = await load();
    await expect(settings.update({ permissionGlobalRules: ["bad tool name"] })).rejects.toThrow(/工具名无效/);
    await expect(settings.update({ permissionGlobalRules: [`bash|${"x".repeat(513)}`] })).rejects.toThrow(/512/);
    await expect(settings.update({ permissionHighRiskTools: Array.from({ length: 33 }, (_, index) => `t${index}`) })).rejects.toThrow(/最多 32/);

    await settings.update({
      permissionGlobalRules: ["bash|npm test", "web_search"],
      permissionHighRiskCommands: ["terraform apply"],
      permissionHighRiskTools: ["mcp__prod__deploy"],
    });
    expect(settings.effective().permissionGlobalRules).toEqual([
      { tool: "bash", argumentPrefix: "npm test" },
      { tool: "web_search" },
    ]);
    expect(settings.effective().permissionHighRisk).toEqual({ commands: ["terraform apply"], tools: ["mcp__prod__deploy"] });
  });
});
