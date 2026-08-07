import { describe, expect, it } from "vitest";
import { OFFICIAL_DEFAULT_CONFIG, OFFICIAL_EXTENSIONS } from "../src/extensions/official.js";
import { validateConfigAgainstSchema } from "../src/extensions/config-schema.js";

describe("官方扩展 configSchema", () => {
  it("每个官方扩展的默认配置通过自身 schema 校验（防漂移）", () => {
    for (const manifest of OFFICIAL_EXTENSIONS) {
      const defaults = OFFICIAL_DEFAULT_CONFIG[manifest.id];
      expect(defaults, `${manifest.id} 缺少默认配置`).toBeDefined();
      if (!manifest.configSchema) continue;
      const problem = validateConfigAgainstSchema(manifest.configSchema, defaults);
      expect(problem, `${manifest.id} 默认配置未通过 schema: ${problem ?? ""}`).toBeNull();
    }
  });

  it("带表单的官方扩展均声明 configSchema（设置页不再回退 JSON 编辑）", () => {
    // context-manager 按会话在「上下文」面板配置；owc-eval 无可配置项——二者例外
    const exempt = new Set(["context-manager", "owc-eval"]);
    for (const manifest of OFFICIAL_EXTENSIONS) {
      if (exempt.has(manifest.id)) continue;
      expect(manifest.configSchema, `${manifest.id} 缺少 configSchema`).toBeDefined();
    }
  });

  it("schema 属性均带 title 与 description（设置页描述条目）", () => {
    const checkProperties = (properties: Record<string, unknown>, path: string): void => {
      for (const [key, raw] of Object.entries(properties)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const spec = raw as Record<string, unknown>;
        expect(typeof spec.title, `${path}.${key} 缺少 title`).toBe("string");
        expect(spec.title === "" || typeof spec.description === "string", `${path}.${key} 缺少 description`).toBe(true);
        if (spec.properties && typeof spec.properties === "object" && !Array.isArray(spec.properties)) {
          checkProperties(spec.properties as Record<string, unknown>, `${path}.${key}`);
        }
      }
    };
    for (const manifest of OFFICIAL_EXTENSIONS) {
      const properties = manifest.configSchema?.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
      checkProperties(properties as Record<string, unknown>, manifest.id);
    }
  });
});
