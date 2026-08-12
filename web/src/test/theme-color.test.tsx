import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useTheme } from "../theme";

/** theme-color 元数据跟随主题：theme.ts 持有/创建 meta[name="theme-color"]，内容取解析后的 body 背景 */

afterEach(() => {
  document.querySelector('meta[name="theme-color"]')?.remove();
  document.documentElement.removeAttribute("data-theme");
  document.body.style.backgroundColor = "";
  window.localStorage.clear();
});

describe("theme-color 跟随主题", () => {
  it("挂载写入 meta（缺失则创建），主题切换后内容跟随更新", () => {
    document.body.style.backgroundColor = "rgb(241, 244, 245)";
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    const meta = document.querySelector('meta[name="theme-color"]');
    expect(meta).not.toBeNull();
    expect(meta!.getAttribute("content")).toBe("rgb(241, 244, 245)");
    expect(document.documentElement.dataset.theme).toBe("light");
    // 真实浏览器中 token 随 data-theme 换色；jsdom 无样式表，模拟解析后的暗色背景
    document.body.style.backgroundColor = "rgb(14, 19, 24)";
    act(() => result.current.setPreference("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute("content")).toBe("rgb(14, 19, 24)");
  });

  it("index.html 引导脚本与静态值使用 --bg 同色系（不再写死 #F2F2F2）", async () => {
    const html = await import("node:fs").then((fs) => fs.readFileSync(`${process.cwd()}/index.html`, "utf8"));
    expect(html).not.toContain("#F2F2F2");
    expect(html).toContain('content = t === "dark" ? "#0e1318" : "#f1f4f5"');
  });
});
