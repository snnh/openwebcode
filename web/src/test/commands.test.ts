import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateWhen, getCommand, listCommands, registerCommand, resetCommands, runCommand } from "../app/commands";

afterEach(() => resetCommands());

describe("命令注册表", () => {
  it("注册后可按 id 查找并执行", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.a", title: { zh: "甲", en: "A" }, handler });
    expect(getCommand("test.a")?.title.en).toBe("A");
    expect(runCommand("test.a")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runCommand("test.missing")).toBe(false);
  });

  it("重复 id 注册报错", () => {
    registerCommand({ id: "test.dup", title: { zh: "甲", en: "A" }, handler: () => undefined });
    expect(() => registerCommand({ id: "test.dup", title: { zh: "乙", en: "B" }, handler: () => undefined })).toThrow(/duplicate/);
  });

  it("注销函数移除命令；重复注销不破坏后来注册者", () => {
    const dispose = registerCommand({ id: "test.x", title: { zh: "甲", en: "A" }, handler: () => undefined });
    dispose();
    expect(getCommand("test.x")).toBeUndefined();
    registerCommand({ id: "test.x", title: { zh: "乙", en: "B" }, handler: () => undefined });
    dispose();
    expect(getCommand("test.x")?.title.en).toBe("B");
  });

  it("when 条件：全部满足可用，! 前缀取反", () => {
    expect(evaluateWhen("sessionActive running", { sessionActive: true, running: true })).toBe(true);
    expect(evaluateWhen("sessionActive running", { sessionActive: true })).toBe(false);
    expect(evaluateWhen("!running", { running: false })).toBe(true);
    expect(evaluateWhen("!running", { running: true })).toBe(false);
    expect(evaluateWhen(undefined, {})).toBe(true);
  });

  it("listCommands 按上下文过滤；runCommand 拦截不满足 when 的命令", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.gated", title: { zh: "甲", en: "A" }, when: "sessionActive", handler });
    registerCommand({ id: "test.free", title: { zh: "乙", en: "B" }, handler: () => undefined });
    expect(listCommands({}).map((c) => c.id)).toEqual(["test.free"]);
    expect(listCommands({ sessionActive: true })).toHaveLength(2);
    expect(runCommand("test.gated", {})).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(runCommand("test.gated", { sessionActive: true })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
