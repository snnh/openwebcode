import { cp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempRoot } from "./helpers/temp-roots.js";
import { diffTrees, globToRegExp, relativeExcludes } from "../src/snapshots/tree-diff.js";
// 跨包契约：server 快照 diff 输出必须可被 web 解析器消费（hunk 级还原依赖同形格式）
import { parseUnifiedDiff, reconstructOriginal } from "../../web/src/lib/unified-diff";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTrees(): Promise<{ oldRoot: string; newRoot: string }> {
  const oldRoot = await tempRoot("owc-treediff-old-");
  const newRoot = await tempRoot("owc-treediff-new-");
  roots.push(oldRoot, newRoot);
  await mkdir(path.join(oldRoot, "src"), { recursive: true });
  await mkdir(path.join(newRoot, "src"), { recursive: true });
  // 未变文件：cp 保留 mtime（size/mtime 判定下必须一致）
  await writeFile(path.join(oldRoot, "README.md"), "readme\n", "utf8");
  await cp(path.join(oldRoot, "README.md"), path.join(newRoot, "README.md"));
  // 修改文件（mtime 保证不同）
  await writeFile(path.join(oldRoot, "src", "a.ts"), "line1\nline2\nline3\n", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(newRoot, "src", "a.ts"), "line1\nline2\nline3\nline4\n", "utf8");
  // 新增文件
  await writeFile(path.join(newRoot, "added.txt"), "hello\nworld\n", "utf8");
  // 删除文件
  await writeFile(path.join(oldRoot, "removed.txt"), "bye\n", "utf8");
  return { oldRoot, newRoot };
}

describe("diffTrees（per-file git unified diff）", () => {
  it("产出 stat 摘要 + git 风格 unified diff（可被 hunk 解析）", async () => {
    const { oldRoot, newRoot } = await makeTrees();
    const text = await diffTrees(oldRoot, newRoot);
    expect(text).not.toBeNull();
    const output = text!;
    // stat 行
    expect(output).toContain("A added.txt");
    expect(output).toContain("D removed.txt");
    expect(output).toContain("M src/a.ts");
    // 修改文件走 git：真实 hunk（-1,3 +1,4）
    expect(output).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(output).toContain("@@ -1,3 +1,4 @@");
    expect(output).toContain("+line4");
    // 新增文件：合成 /dev/null 头 + 全文件 hunk
    expect(output).toContain("--- /dev/null");
    expect(output).toContain("@@ -0,0 +1,2 @@");
    expect(output).toContain("+hello");
    // 删除文件：合成 +++ /dev/null
    expect(output).toContain("+++ /dev/null");
    expect(output).toContain("@@ -1,1 +0,0 @@");
    expect(output).toContain("-bye");
    // 未变文件不出现
    expect(output).not.toContain("README.md");
  });

  it("excludes（前缀 + glob）双侧过滤，工作区排除目录不误报为已删除", async () => {
    const { oldRoot, newRoot } = await makeTrees();
    // 双侧都有变更的排除目录 + 新树侧新出现的排除目录
    await mkdir(path.join(oldRoot, "node_modules"), { recursive: true });
    await mkdir(path.join(newRoot, "node_modules"), { recursive: true });
    await writeFile(path.join(oldRoot, "node_modules", "x.js"), "old\n", "utf8");
    await writeFile(path.join(newRoot, "node_modules", "x.js"), "new\n", "utf8");
    await mkdir(path.join(newRoot, "vendor"), { recursive: true });
    await writeFile(path.join(newRoot, "vendor", "v.js"), "new\n", "utf8");
    const text = await diffTrees(oldRoot, newRoot, {
      excludePrefixes: ["node_modules"],
      excludeGlobs: ["vendor/**"],
    });
    expect(text).not.toBeNull();
    expect(text!).not.toContain("node_modules");
    expect(text!).not.toContain("vendor");
    expect(text!).toContain("A added.txt");
  });

  it("relativeExcludes：工作区外 deny 条目跳过，反斜杠归一", async () => {
    const ws = "D:/work/ws";
    const excludes = relativeExcludes(ws, ["D:/work/ws/.env", "D:/other/secret", "D:\\work\\ws\\nested\\key.pem"], ["build/**", "dist"]);
    expect(excludes.excludePrefixes.sort()).toEqual([".env", "nested/key.pem", "dist"].sort());
    expect(excludes.excludeGlobs).toEqual(["build/**"]);
  });

  it("globToRegExp：** 跨目录、* 单段、? 单字符", () => {
    expect(globToRegExp("build/**").test("build/x/y.js")).toBe(true);
    expect(globToRegExp("build/**").test("build")).toBe(false); // gitignore 语义：** 只匹配内部
    expect(globToRegExp("*.log").test("a/b.log")).toBe(false);
    expect(globToRegExp("*.log").test("a.log")).toBe(true);
    expect(globToRegExp("a?.txt").test("ab.txt")).toBe(true);
    expect(globToRegExp("a?.txt").test("abc.txt")).toBe(false);
  });

  it("changedCap 超限：stat 行保留，超出部分无内容 diff 并标注截断", async () => {
    const { oldRoot, newRoot } = await makeTrees();
    await writeFile(path.join(oldRoot, "f1.txt"), "a\n", "utf8");
    await writeFile(path.join(newRoot, "f1.txt"), "b\n", "utf8");
    await writeFile(path.join(oldRoot, "f2.txt"), "a\n", "utf8");
    await writeFile(path.join(newRoot, "f2.txt"), "b\n", "utf8");
    const text = await diffTrees(oldRoot, newRoot, { changedCap: 2 });
    expect(text).not.toBeNull();
    expect(text!).toContain("…（变更文件超限，前 2 个附完整 diff）");
  });

  it("大文件只出 stat 行（内容对比超限）", async () => {
    const { oldRoot, newRoot } = await makeTrees();
    await writeFile(path.join(oldRoot, "big.bin"), "x".repeat(4096), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(newRoot, "big.bin"), "y".repeat(4096), "utf8");
    const text = await diffTrees(oldRoot, newRoot, { maxFileBytes: 1024 });
    expect(text).not.toBeNull();
    expect(text!).toContain("M big.bin");
    expect(text!).not.toContain("diff --git a/big.bin");
  });

  it("git 缺失时返回 null（调用方降级）", async () => {
    const { oldRoot, newRoot } = await makeTrees();
    const savedPath = process.env.PATH;
    const empty = await tempRoot("owc-treediff-nogit-");
    roots.push(empty);
    process.env.PATH = empty;
    try {
      const text = await diffTrees(oldRoot, newRoot);
      expect(text).toBeNull();
    } finally {
      if (savedPath !== undefined) process.env.PATH = savedPath;
    }
  });

  it("whiteoutAsDeleted：设备条目视为删除标记（POSIX fifo 模拟）", async (context) => {
    if (process.platform === "win32") context.skip();
    const { oldRoot, newRoot } = await makeTrees();
    // 旧树有 regular 文件，新树侧以 fifo（非 regular 条目）代替 = 已删除
    await writeFile(path.join(oldRoot, "gone.txt"), "content\n", "utf8");
    execFileSync("mkfifo", [path.join(newRoot, "gone.txt")]);
    const text = await diffTrees(oldRoot, newRoot, { whiteoutAsDeleted: true });
    expect(text).not.toBeNull();
    expect(text!).toContain("D gone.txt");
  });

  it("两侧完全一致时输出空", async () => {
    const oldRoot = await tempRoot("owc-treediff-ident-");
    roots.push(oldRoot);
    await mkdir(path.join(oldRoot, "src"), { recursive: true });
    await writeFile(path.join(oldRoot, "README.md"), "readme\n", "utf8");
    await writeFile(path.join(oldRoot, "src", "a.ts"), "line1\nline2\n", "utf8");
    const newRoot = await tempRoot("owc-treediff-ident2-");
    roots.push(newRoot);
    await cp(oldRoot, newRoot, { recursive: true }); // cp 保留 mtime
    const text = await diffTrees(oldRoot, newRoot);
    expect(text).not.toBeNull();
    expect(text!.trim()).toBe("");
  });

  it("输出可被 web parseUnifiedDiff 解析，roundtrip 还原新侧内容", async () => {
    const { oldRoot, newRoot } = await makeTrees();
    const text = (await diffTrees(oldRoot, newRoot))!;
    const files = parseUnifiedDiff(text);
    const byPath = new Map(files.map((file) => [file.oldPath || file.newPath, file]));
    expect(byPath.has("src/a.ts")).toBe(true);
    expect(byPath.has("added.txt")).toBe(true);
    expect(byPath.has("removed.txt")).toBe(true);
    expect(byPath.has("README.md")).toBe(false);
    // 新侧内容 + hunk 还原 = 旧侧内容（web reconstructOriginal 语义）
    const old = await readFile(path.join(oldRoot, "src", "a.ts"), "utf8");
    const fresh = await readFile(path.join(newRoot, "src", "a.ts"), "utf8");
    expect(reconstructOriginal(fresh, byPath.get("src/a.ts")!)).toBe(old);
    // 新增文件：新侧内容 + diff 还原为空（旧侧无内容）
    expect(reconstructOriginal("hello\nworld\n", byPath.get("added.txt")!)).toBe("");
  });
});
