/**
 * unified diff 解析与 hunk 还原单测（0.5.0 Phase 1b）：
 * 解析正确性（多文件/hunk 边界/新增/删除）、revertHunks 内容写回（含行号漂移定位与失配报错）、
 * reconstructOriginal 反推旧侧全文。
 */
import { describe, expect, it } from "vitest";
import { HunkRevertError, hunkNewText, hunkOldText, parseUnifiedDiff, reconstructOriginal, revertHunks } from "../lib/unified-diff";

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " line1",
  "-line2",
  "+line2 changed",
  " line3",
  " line4",
  "+line5 added",
  "@@ -10,3 +11,2 @@ tail context",
  " line10",
  "-line11",
  " line12",
  "diff --git a/dev/null b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+fresh1",
  "+fresh2",
].join("\n");

const CURRENT_A = ["line1", "line2 changed", "line3", "line4", "line5 added", "x", "y", "z", "w", "line10", "line12"].join("\n");

describe("parseUnifiedDiff", () => {
  it("解析多文件与 hunk 头（含尾部上下文说明、缺省行数）", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(2);
    const [a, added] = files;
    expect(a).toMatchObject({ oldPath: "src/a.ts", newPath: "src/a.ts", isNew: false, isDeleted: false });
    expect(a!.hunks).toHaveLength(2);
    expect(a!.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 });
    expect(a!.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 11, newLines: 2 });
    expect(a!.hunks[1]!.header).toContain("tail context");
    expect(added).toMatchObject({ oldPath: "", newPath: "src/new.ts", isNew: true });
    expect(hunkNewText(added!.hunks[0]!)).toEqual(["fresh1", "fresh2"]);
    expect(hunkOldText(a!.hunks[0]!)).toEqual(["line1", "line2", "line3", "line4"]);
  });

  it("跳过 stat 摘要等非 diff 内容；无 diff 段返回空数组", () => {
    expect(parseUnifiedDiff(" a.txt | 2 +-\n 1 file changed")).toEqual([]);
    const mixed = ` src/a.ts | 2 +-\n\n${SAMPLE}`;
    expect(parseUnifiedDiff(mixed)).toHaveLength(2);
  });

  it("删除文件：newPath 为空且 isDeleted", () => {
    const text = ["diff --git a/old.txt b/old.txt", "deleted file mode 100644", "--- a/old.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n");
    const files = parseUnifiedDiff(text);
    expect(files[0]).toMatchObject({ oldPath: "old.txt", newPath: "", isDeleted: true });
  });
});

describe("revertHunks", () => {
  const file = parseUnifiedDiff(SAMPLE)[0]!;

  it("拒绝单个 hunk：新侧替换回旧侧", () => {
    const next = revertHunks(CURRENT_A, file, [0]);
    expect(next).toBe(["line1", "line2", "line3", "line4", "x", "y", "z", "w", "line10", "line12"].join("\n"));
  });

  it("多个 hunk 自底向上应用，互不位移", () => {
    const next = revertHunks(CURRENT_A, file, [0, 1]);
    expect(next).toBe(["line1", "line2", "line3", "line4", "x", "y", "z", "w", "line10", "line11", "line12"].join("\n"));
  });

  it("行号漂移：newStart 不符时按内容全文定位", () => {
    // 文件头部多插入一行，hunk 行号整体下移 1
    const shifted = `inserted\n${CURRENT_A}`;
    const next = revertHunks(shifted, file, [1]);
    expect(next).toBe(["inserted", "line1", "line2 changed", "line3", "line4", "line5 added", "x", "y", "z", "w", "line10", "line11", "line12"].join("\n"));
  });

  it("内容与 hunk 不匹配时抛 HunkRevertError（code 供 UI 映射 i18n 文案，不静默写坏文件）", () => {
    const tampered = CURRENT_A.replace("line2 changed", "something else");
    let caught: unknown;
    try {
      revertHunks(tampered, file, [0]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HunkRevertError);
    expect((caught as HunkRevertError).code).toBe("hunk-content-mismatch");
    // message 只承载英文技术细节，不含上屏中文
    expect((caught as HunkRevertError).message).not.toMatch(/[一-鿿]/);
  });

  it("无效 hunk 下标抛 HunkRevertError（invalid-hunk-index）", () => {
    let caught: unknown;
    try {
      revertHunks(CURRENT_A, file, [99]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HunkRevertError);
    expect((caught as HunkRevertError).code).toBe("invalid-hunk-index");
  });

  it("reconstructOriginal 反推旧侧全文", () => {
    const original = reconstructOriginal(CURRENT_A, file);
    expect(original).toBe(["line1", "line2", "line3", "line4", "x", "y", "z", "w", "line10", "line11", "line12"].join("\n"));
  });
});
