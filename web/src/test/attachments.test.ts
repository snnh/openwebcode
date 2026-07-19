import { describe, expect, it } from "vitest";
import { extractAttachmentPaths, toAttachments } from "../lib/attachments";

describe("extractAttachmentPaths", () => {
  it("extracts @relpath tokens from text preserving order and deduping", () => {
    expect(extractAttachmentPaths("看下 @src/a.ts 和 @src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(extractAttachmentPaths("@a.ts 再 @a.ts 重复")).toEqual(["a.ts"]);
    expect(extractAttachmentPaths("开头 @a.ts")).toEqual(["a.ts"]);
    expect(extractAttachmentPaths("尾部 @b.ts")).toEqual(["b.ts"]);
  });

  it("ignores email-like tokens (a@b) and tokens without a leading boundary", () => {
    expect(extractAttachmentPaths("联系 user@example.com")).toEqual([]);
    expect(extractAttachmentPaths("foo@bar.ts")).toEqual([]);
  });

  it("ignores bare @ without a following path", () => {
    expect(extractAttachmentPaths("单独的 @ 符号")).toEqual([]);
    expect(extractAttachmentPaths("@ 空格后无路径")).toEqual([]);
  });

  it("extracts multiple tokens on one line and keeps extension-only fragments", () => {
    expect(extractAttachmentPaths("@a.ts @b.ts @c.md")).toEqual(["a.ts", "b.ts", "c.md"]);
  });

  it("returns empty for plain text without @", () => {
    expect(extractAttachmentPaths("普通文本无引用")).toEqual([]);
  });
});

describe("toAttachments", () => {
  it("maps paths to { path } attachments", () => {
    expect(toAttachments(["a.ts", "b.ts"])).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
    expect(toAttachments([])).toEqual([]);
  });
});
