import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 高亮缓存的「条数 + 累计体积」双重上限行为测试。
 * 打桩 shiki 高亮器（不加载真语法）：记录每次真实渲染/分词的内容——命中缓存不会再次调用，
 * 据此判断某个 key 的条目是否已被逐出；pad 用于把单条 HTML 撑到指定体积，模拟大代码块。
 */
const state = vi.hoisted(() => ({
  rendered: [] as string[],
  tokenized: [] as string[],
  pad: 0,
}));

vi.mock("../shiki-highlighter", () => ({
  createOwcHighlighter: async () => ({
    loadLanguage: async () => undefined,
    codeToHtml: (code: string) => {
      state.rendered.push(code);
      return `<pre>${code}</pre>${"y".repeat(state.pad)}`;
    },
    codeToTokens: (code: string) => {
      state.tokenized.push(code);
      return { tokens: code.split("\n").map((line) => [{ content: line, htmlStyle: undefined }]) };
    },
  }),
}));

/** 每个 test 用全新模块实例，避免缓存跨用例串味 */
async function loadHighlight() {
  vi.resetModules();
  return import("../highlight");
}

/** 某段代码被真实渲染（即未命中缓存）的次数 */
function renderCount(code: string): number {
  return state.rendered.filter((item) => item === code).length;
}

describe("高亮缓存双重上限", () => {
  beforeEach(() => {
    state.rendered.length = 0;
    state.tokenized.length = 0;
    state.pad = 0;
  });

  it("条数上限保持 256：第 257 条挤掉最旧条目，其余仍命中缓存", async () => {
    const { highlightCode } = await loadHighlight();
    const codes = Array.from({ length: 257 }, (_, index) => `const value${index} = ${index};`);
    for (const code of codes) await highlightCode(code, "typescript");
    expect(state.rendered).toHaveLength(257);
    // 最旧的 code0 已被逐出 → 再次高亮必须重算；最新的 code256 仍命中缓存
    await highlightCode(codes[0]!, "typescript");
    expect(renderCount(codes[0]!)).toBe(2);
    await highlightCode(codes[256]!, "typescript");
    expect(renderCount(codes[256]!)).toBe(1);
  });

  it("LRU：命中把条目移到最新位，逐出的是此后最旧的条目", async () => {
    const { highlightCode } = await loadHighlight();
    const codes = Array.from({ length: 256 }, (_, index) => `const value${index} = ${index};`);
    for (const code of codes) await highlightCode(code, "typescript");
    await highlightCode(codes[0]!, "typescript"); // 命中 → code0 变最新
    await highlightCode("const newest = 1;", "typescript"); // 超条数上限 → 逐出 code1
    await highlightCode(codes[1]!, "typescript");
    expect(renderCount(codes[1]!)).toBe(2);
    await highlightCode(codes[0]!, "typescript");
    expect(renderCount(codes[0]!)).toBe(1);
  });

  it("体积上限 8 MiB：条数远未超限时，大块按体积从最旧逐出", async () => {
    const { highlightCode } = await loadHighlight();
    // 单条 HTML ≈ 2 MB 字符 → 估算 4 MB 字节；2 条未超 8 MiB，3 条触发体积逐出
    state.pad = 2_000_000;
    const codes = ["const big0 = 0;", "const big1 = 1;", "const big2 = 2;"];
    for (const code of codes) await highlightCode(code, "typescript");
    expect(state.rendered).toHaveLength(3);
    // 最新的两条仍在缓存（命中不重算）
    await highlightCode(codes[2]!, "typescript");
    await highlightCode(codes[1]!, "typescript");
    expect(state.rendered).toHaveLength(3);
    // 最旧的一条因体积超限被逐出
    await highlightCode(codes[0]!, "typescript");
    expect(renderCount(codes[0]!)).toBe(2);
  });

  it("按行高亮（string[]）同样计入体积上限", async () => {
    const { highlightLines } = await loadHighlight();
    // 单行 1.5 MB 字符 → 估算 3 MB 字节；3 条累计超过 8 MiB 触发逐出
    const codes = ["a".repeat(1_500_000), "b".repeat(1_500_000), "c".repeat(1_500_000)];
    for (const code of codes) await highlightLines(code, "typescript");
    expect(state.tokenized).toHaveLength(3);
    await highlightLines(codes[2]!, "typescript");
    expect(state.tokenized).toHaveLength(3);
    await highlightLines(codes[0]!, "typescript");
    expect(state.tokenized).toHaveLength(4);
  });
});
