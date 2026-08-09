import { describe, it, expect } from "vitest";
import { chatTools, calculateExpression } from "../src/chat/chat-tools.js";

describe("chatTools", () => {
  it("returns all 10 tools", () => {
    const tools = chatTools();
    expect(tools.length).toBe(10);
    const names = tools.map((t) => t.name);
    expect(names).toContain("time");
    expect(names).toContain("calculate");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("image_gen");
    expect(names).toContain("vision");
    expect(names).toContain("python");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("show");
  });

  it("categorizes tools correctly", () => {
    const tools = chatTools();
    const utility = tools.filter((t) => t.category === "utility").map((t) => t.name);
    const web = tools.filter((t) => t.category === "web").map((t) => t.name);
    const media = tools.filter((t) => t.category === "media").map((t) => t.name);
    const sandbox = tools.filter((t) => t.category === "sandbox").map((t) => t.name);

    expect(utility).toEqual(["time", "calculate"]);
    expect(web).toEqual(["web_search", "web_fetch"]);
    expect(media).toEqual(["image_gen", "vision"]);
    expect(sandbox).toEqual(["python", "read_file", "write_file", "show"]);
  });

  it("marks sandbox tools as requiring sandbox", () => {
    const tools = chatTools();
    const sandboxTools = tools.filter((t) => t.requiresSandbox);
    expect(sandboxTools.map((t) => t.name)).toEqual(["python", "read_file", "write_file", "show"]);
  });
});

describe("calculateExpression", () => {
  it("evaluates basic arithmetic", () => {
    expect(calculateExpression("1 + 2")).toBe(3);
    expect(calculateExpression("10 - 4")).toBe(6);
    expect(calculateExpression("3 * 4")).toBe(12);
    expect(calculateExpression("15 / 3")).toBe(5);
    expect(calculateExpression("10 % 3")).toBe(1);
  });

  it("handles operator precedence", () => {
    expect(calculateExpression("2 + 3 * 4")).toBe(14);
    expect(calculateExpression("(2 + 3) * 4")).toBe(20);
    expect(calculateExpression("2 ^ 3 ^ 2")).toBe(512);
  });

  it("handles unary operators", () => {
    expect(calculateExpression("-5")).toBe(-5);
    expect(calculateExpression("--5")).toBe(5);
    expect(calculateExpression("-3 + 7")).toBe(4);
  });

  it("evaluates functions", () => {
    expect(calculateExpression("sqrt(16)")).toBe(4);
    expect(calculateExpression("abs(-5)")).toBe(5);
    expect(calculateExpression("sin(0)")).toBe(0);
    expect(calculateExpression("cos(0)")).toBe(1);
    expect(calculateExpression("log(100)")).toBe(2);
    expect(calculateExpression("ln(2.718281828459045)")).toBeCloseTo(1);
  });

  it("handles constants", () => {
    expect(calculateExpression("pi")).toBeCloseTo(Math.PI);
    expect(calculateExpression("e")).toBeCloseTo(Math.E);
  });

  it("rejects invalid expressions", () => {
    expect(() => calculateExpression("")).toThrow();
    expect(() => calculateExpression("abc")).toThrow();
    expect(() => calculateExpression("1 +")).toThrow();
    expect(() => calculateExpression("()")).toThrow();
  });
});
