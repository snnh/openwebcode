import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreLogArchive } from "../src/core-log.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-corelog-"));
  roots.push(root);
  return root;
}

describe("CoreLogArchive", () => {
  it("initialize 创建目录，append 追加写入 core.log", async () => {
    const root = await makeRoot();
    const archive = new CoreLogArchive(path.join(root, "logs"));
    await archive.initialize();
    archive.append("[owc-exec] first\n");
    archive.append("[owc-exec] second\n");
    await vi.waitFor(async () => {
      expect(await readFile(path.join(root, "logs", "core.log"), "utf8")).toBe("[owc-exec] first\n[owc-exec] second\n");
    });
  });

  it("超过阈值的 core.log 在 initialize 时轮转为 core.log.1（只保留一代）", async () => {
    const root = await makeRoot();
    const logDir = path.join(root, "logs");
    const archive = new CoreLogArchive(logDir, 16);
    await archive.initialize();
    await writeFile(path.join(logDir, "core.log"), "x".repeat(32), "utf8");
    await writeFile(path.join(logDir, "core.log.1"), "previous-generation", "utf8");
    await archive.initialize();
    expect(await readFile(path.join(logDir, "core.log.1"), "utf8")).toBe("x".repeat(32));
    // core.log 已被轮转走，append 后重新创建
    archive.append("fresh\n");
    await vi.waitFor(async () => {
      expect(await readFile(path.join(logDir, "core.log"), "utf8")).toBe("fresh\n");
    });
  });

  it("未超阈值不轮转", async () => {
    const root = await makeRoot();
    const logDir = path.join(root, "logs");
    const archive = new CoreLogArchive(logDir, 1024);
    await archive.initialize();
    await writeFile(path.join(logDir, "core.log"), "small\n", "utf8");
    await archive.initialize();
    expect(await readFile(path.join(logDir, "core.log"), "utf8")).toBe("small\n");
    await expect(stat(path.join(logDir, "core.log.1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("append 失败静默吞掉（未 initialize 目录不存在也不抛错）", async () => {
    const root = await makeRoot();
    const archive = new CoreLogArchive(path.join(root, "missing", "logs"));
    archive.append("dropped\n");
    // 不抛错即通过；给 appendFile 一个失败的机会
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
