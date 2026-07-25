import { describe, expect, it } from "vitest";
import { extractSymbols, languageForPath, type SymbolKind } from "../src/index/symbols.js";
import { fuzzyScore } from "../src/index/index-manager.js";
import { diffManifest } from "../src/index/manifest.js";

/** 提取结果简化为 "kind:name@line" 便于 golden 断言。 */
function simplify(language: string, text: string): string[] {
  return extractSymbols(language, text).map((symbol) => `${symbol.kind}:${symbol.name}@${symbol.startLine}`);
}

describe("符号提取器 per-language golden（§4.1）", () => {
  it("typescript：function/class/interface/type/enum/const/method", () => {
    const ts = [
      `export function greet(name: string): string {`,
      `  return name;`,
      `}`,
      `export class Greeter {`,
      `  private prefix = "hi";`,
      `  async sayHello(name: string) {`,
      `    return greet(name);`,
      `  }`,
      `}`,
      `export interface Config { debug: boolean }`,
      `export type Mode = "a" | "b";`,
      `export enum Level { Low, High }`,
      `export const DEFAULT_MODE: Mode = "a";`,
    ].join("\n");
    expect(simplify("typescript", ts)).toEqual([
      "function:greet@1",
      "class:Greeter@4",
      "method:sayHello@6",
      "interface:Config@10",
      "type:Mode@11",
      "enum:Level@12",
      "constant:DEFAULT_MODE@13",
    ]);
  });

  it("javascript：复用 TS 规则", () => {
    const js = `function helper() {\n}\nexport const VERSION = "1.0.0";\nclass App {\n  static create() {\n  }\n}`;
    expect(simplify("javascript", js)).toEqual(["function:helper@1", "constant:VERSION@3", "class:App@4", "method:create@5"]);
  });

  it("python：def/class，缩进 def 视为 method", () => {
    const py = `def top_level(a, b):\n    return a\n\nclass Service:\n    def handle(self, request):\n        return request\n\nasync def fetch(url):\n    pass`;
    expect(simplify("python", py)).toEqual([
      "function:top_level@1",
      "class:Service@4",
      "method:handle@5",
      "function:fetch@8",
    ]);
  });

  it("go：func/method/type struct/interface", () => {
    const go = `package main\n\nfunc main() {\n}\n\nfunc (s *Server) Start(addr string) error {\n  return nil\n}\n\ntype Config struct {\n  Port int\n}\n\ntype Handler interface {\n  Serve()\n}\n\ntype Port = int`;
    expect(simplify("go", go)).toEqual([
      "function:main@3",
      "method:Start@6",
      "struct:Config@10",
      "interface:Handler@14",
      "type:Port@18",
    ]);
  });

  it("rust：fn/struct/enum/trait/impl/const", () => {
    const rs = `pub fn compute(x: i32) -> i32 {\n  x * 2\n}\n\npub struct Point {\n  x: f64,\n}\n\nenum Color {\n  Red,\n}\n\npub trait Drawable {\n  fn draw(&self);\n}\n\nimpl Point {\n  fn new() -> Self { Point { x: 0.0 } }\n}\n\nconst MAX_RETRY: u32 = 3;`;
    expect(simplify("rust", rs)).toEqual([
      "function:compute@1",
      "struct:Point@5",
      "enum:Color@9",
      "trait:Drawable@13",
      "function:draw@14", // trait 体内的 fn 也收录（够用导航，不追求 scope 精确）
      "impl:Point@17",
      "function:new@18",
      "constant:MAX_RETRY@21",
    ]);
  });

  it("c：函数定义与 struct；函数声明（;结尾）不收录", () => {
    const c = `#include <stdio.h>\n\nint add(int a, int b) {\n  return a + b;\n}\n\nint subtract(int a, int b);\n\nstruct node {\n  int value;\n};\n\nstatic void helper(void)\n{\n}`;
    const symbols = simplify("c", c);
    expect(symbols).toContain("function:add@3");
    expect(symbols).toContain("struct:node@9");
    expect(symbols).toContain("function:helper@13");
    expect(symbols.some((entry) => entry.includes("subtract"))).toBe(false);
    expect(symbols.some((entry) => entry.includes("include"))).toBe(false);
  });

  it("cpp：class 与函数", () => {
    const cpp = `class Widget {\npublic:\n  void draw();\n};\n\nvoid render(Widget& w) {\n  w.draw();\n}`;
    const symbols = simplify("cpp", cpp);
    expect(symbols).toContain("class:Widget@1");
    expect(symbols).toContain("function:render@6");
    expect(symbols.some((entry) => entry.includes("draw"))).toBe(false); // 类内声明不收录
  });

  it("java：class/interface/method（含构造器）", () => {
    const java = `public class App {\n  private final String name;\n\n  public App(String name) {\n    this.name = name;\n  }\n\n  public static void main(String[] args) {\n  }\n\n  public String name() {\n    return name;\n  }\n}\n\ninterface Repository {\n  void save();\n}`;
    const symbols = simplify("java", java);
    expect(symbols).toContain("class:App@1");
    expect(symbols).toContain("method:App@4");
    expect(symbols).toContain("method:main@8");
    expect(symbols).toContain("method:name@11");
    expect(symbols).toContain("interface:Repository@16");
  });

  it("csharp：class/struct/interface/method", () => {
    const cs = `public class Program {\n  private readonly int count;\n\n  public static void Main(string[] args) {\n  }\n\n  private async Task RunAsync() {\n    await Task.Yield();\n  }\n}\n\npublic struct Vec2 {\n  public float X;\n}\n\ninternal interface IService {\n  void Start();\n}`;
    const symbols = simplify("csharp", cs);
    expect(symbols).toContain("class:Program@1");
    expect(symbols).toContain("method:Main@4");
    expect(symbols).toContain("method:RunAsync@7");
    expect(symbols).toContain("struct:Vec2@12");
    expect(symbols).toContain("interface:IService@16");
  });

  it("行区间为近似闭区间且 signature 有界", () => {
    const ts = `function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}`;
    const symbols = extractSymbols("typescript", ts);
    expect(symbols[0]).toMatchObject({ name: "a", startLine: 1, endLine: 3, signature: "function a() {" });
    expect(symbols[1]).toMatchObject({ name: "b", startLine: 4, endLine: 6 });
  });

  it("languageForPath 覆盖 8 语言并拒绝未知扩展", () => {
    expect(languageForPath("src/a.ts")).toBe("typescript");
    expect(languageForPath("src/a.tsx")).toBe("typescript");
    expect(languageForPath("src/a.jsx")).toBe("javascript");
    expect(languageForPath("pkg/main.go")).toBe("go");
    expect(languageForPath("src/lib.rs")).toBe("rust");
    expect(languageForPath("src/x.h")).toBe("c");
    expect(languageForPath("src/x.hpp")).toBe("cpp");
    expect(languageForPath("App.java")).toBe("java");
    expect(languageForPath("Program.cs")).toBe("csharp");
    expect(languageForPath("README.md")).toBeUndefined();
    expect(languageForPath("Makefile")).toBeUndefined();
  });
});

describe("manifest diff（core 完整 manifest → Node 增量）", () => {
  const entry = (path: string, overrides: Partial<{ size: number; modifiedMs: number; sha256: string }> = {}) => ({
    path, size: 10, modifiedMs: 100, ...overrides,
  });

  it("sha256 优先判定新增/修改/删除", () => {
    const prev = new Map([
      ["a.ts", entry("a.ts", { sha256: "1" })],
      ["b.ts", entry("b.ts", { sha256: "2" })],
      ["c.ts", entry("c.ts", { sha256: "3" })],
    ]);
    const next = [
      entry("a.ts", { sha256: "1" }),           // 不变
      entry("b.ts", { sha256: "2x" }),          // hash 变 → changed
      entry("d.ts", { sha256: "4" }),           // 新增
    ];
    const diff = diffManifest(prev, next);
    expect(diff.added.map((e) => e.path)).toEqual(["d.ts"]);
    expect(diff.changed.map((e) => e.path)).toEqual(["b.ts"]);
    expect(diff.deleted).toEqual(["c.ts"]);
  });

  it("缺 hash 时退回 size+modifiedMs；mtime 变但 hash 同则不算变化", () => {
    const prev = new Map([["a.ts", entry("a.ts")], ["b.ts", entry("b.ts", { sha256: "h" })]]);
    const same = diffManifest(prev, [entry("a.ts"), entry("b.ts", { sha256: "h", modifiedMs: 999 })]);
    expect(same.changed).toEqual([]);
    const changed = diffManifest(prev, [entry("a.ts", { modifiedMs: 200 }), entry("b.ts", { sha256: "h" })]);
    expect(changed.changed.map((e) => e.path)).toEqual(["a.ts"]);
  });
});

describe("fuzzyScore 模糊匹配评分", () => {
  it("精确 > 前缀 > 子串 > 子序列 > 不匹配", () => {
    expect(fuzzyScore("render", "render")).toBe(100);
    expect(fuzzyScore("Render", "render")).toBe(100); // 大小写不敏感
    expect(fuzzyScore("renderFrame", "render")).toBe(75);
    expect(fuzzyScore("reRenderFrame", "render")).toBe(50);
    expect(fuzzyScore("r_e_n_d_e_r", "render")).toBe(25);
    expect(fuzzyScore("abc", "xyz")).toBe(0);
    expect(fuzzyScore("abc", "")).toBe(0);
  });
});

describe("SymbolKind 覆盖", () => {
  it("提取结果 kind 均在声明集合内", () => {
    const kinds: SymbolKind[] = ["function", "method", "class", "interface", "type", "struct", "enum", "trait", "impl", "constant"];
    const found = new Set(extractSymbols("rust", "fn f() {}\nstruct S {}\ntrait T {}\nimpl S {}\nconst C: u8 = 0;").map((s) => s.kind));
    for (const kind of found) expect(kinds).toContain(kind);
  });
});
