import { describe, expect, it } from "vitest";
import { deriveAccentVars, hexToRgb, isValidHexColor, relativeLuminance } from "../lib/accent-color";
import { parseAccent } from "../theme";

describe("自定义强调色：hex 解析与变量派生", () => {
  it("isValidHexColor 只接受 #rrggbb", () => {
    expect(isValidHexColor("#0b7285")).toBe(true);
    expect(isValidHexColor("#A1B2C3")).toBe(true);
    expect(isValidHexColor("0b7285")).toBe(false);
    expect(isValidHexColor("#abc")).toBe(false);
    expect(isValidHexColor("#gg0000")).toBe(false);
  });

  it("浅色主题：hover 加深、on-accent 按亮度取黑白、soft 12% 透明度", () => {
    const vars = deriveAccentVars("#0b7285", "light");
    expect(vars).toBeDefined();
    expect(vars!.accent).toBe("#0b7285");
    // hover 更深（亮度更低）且仍为 hex
    expect(isValidHexColor(vars!.accentHover)).toBe(true);
    expect(relativeLuminance(hexToRgb(vars!.accentHover))).toBeLessThan(relativeLuminance(hexToRgb("#0b7285")));
    // 深色原色 → 白字
    expect(vars!.onAccent).toBe("#ffffff");
    expect(vars!.accentSoft).toBe("rgb(11 114 133 / 0.12)");
  });

  it("深色主题：hover 提亮、soft 24% 透明度；浅色原色取黑字", () => {
    const vars = deriveAccentVars("#c9ced4", "dark");
    expect(vars).toBeDefined();
    expect(relativeLuminance(hexToRgb(vars!.accentHover))).toBeGreaterThan(relativeLuminance(hexToRgb("#c9ced4")));
    expect(vars!.onAccent).toBe("#1c2126");
    expect(vars!.accentSoft).toContain("/ 0.24");
  });

  it("非法输入返回 undefined（调用方不应用）", () => {
    expect(deriveAccentVars("red", "light")).toBeUndefined();
    expect(deriveAccentVars("#12345", "dark")).toBeUndefined();
  });

  it("parseAccent：预设名 / custom:#rrggbb / 非法回落 graphite", () => {
    expect(parseAccent("teal")).toBe("teal");
    expect(parseAccent("graphite")).toBe("graphite");
    expect(parseAccent("custom:#a1b2c3")).toBe("custom:#a1b2c3");
    expect(parseAccent("custom:#A1B2C3")).toBe("custom:#A1B2C3");
    expect(parseAccent("custom:red")).toBe("graphite");
    expect(parseAccent("nonsense")).toBe("graphite");
    expect(parseAccent(null)).toBe("graphite");
  });
});
