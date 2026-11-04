import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CORE_REQUEST_TIMEOUT_MS,
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_RPC_MARGIN_MS,
  MAX_EXEC_TIMEOUT_MS,
  execRpcTimeoutMs,
} from "../src/exec-timeout.js";

describe("exec timeout policy", () => {
  it("0（不限时）不设置 RPC 定时器", () => {
    expect(execRpcTimeoutMs(0)).toBe(0);
  });

  it("有软超时时，RPC 等待为命令超时 + 收尾余量", () => {
    expect(execRpcTimeoutMs(1_000)).toBe(1_000 + EXEC_TIMEOUT_RPC_MARGIN_MS);
  });

  it("最大设置值 + 余量不会溢出 Node 定时器上限", () => {
    expect(execRpcTimeoutMs(MAX_EXEC_TIMEOUT_MS)).toBe(MAX_EXEC_TIMEOUT_MS);
  });

  it("安装默认配置与代码默认值保持同步", () => {
    const defaults = JSON.parse(readFileSync(fileURLToPath(new URL("../src/config/defaults.json", import.meta.url)), "utf8")) as Record<string, unknown>;
    expect(defaults.execTimeoutMs).toBe(DEFAULT_EXEC_TIMEOUT_MS);
    expect(defaults.coreRequestTimeoutMs).toBe(DEFAULT_CORE_REQUEST_TIMEOUT_MS);
  });

  it("默认值与 core 协议上限保持单一来源", () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(30 * 60_000);
    expect(DEFAULT_CORE_REQUEST_TIMEOUT_MS).toBe(130_000);
    expect(MAX_EXEC_TIMEOUT_MS).toBe(2_147_483_647);
  });
});
