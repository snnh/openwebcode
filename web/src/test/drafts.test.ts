import { beforeEach, describe, expect, it } from "vitest";
import { clearDraft, loadDraft, pruneDrafts, saveDraft } from "../lib/drafts";

beforeEach(() => window.localStorage.clear());

describe("Composer 草稿持久化", () => {
  it("写入后可按会话读回", () => {
    saveDraft("s1", "未发送的草稿");
    expect(loadDraft("s1")).toBe("未发送的草稿");
    expect(window.localStorage.getItem("owc-draft-s1")).toBe(JSON.stringify("未发送的草稿"));
  });

  it("空串写入等价于清除条目（发送后清理）", () => {
    saveDraft("s1", "内容");
    saveDraft("s1", "");
    expect(window.localStorage.getItem("owc-draft-s1")).toBeNull();
    expect(loadDraft("s1")).toBeUndefined();
  });

  it("clearDraft 删除条目", () => {
    saveDraft("s1", "内容");
    clearDraft("s1");
    expect(loadDraft("s1")).toBeUndefined();
  });

  it("JSON 损坏时返回 undefined 而不是抛错", () => {
    window.localStorage.setItem("owc-draft-s1", "{not json");
    expect(loadDraft("s1")).toBeUndefined();
    window.localStorage.setItem("owc-draft-s1", "123");
    expect(loadDraft("s1")).toBeUndefined();
    window.localStorage.setItem("owc-draft-s1", JSON.stringify(""));
    expect(loadDraft("s1")).toBeUndefined();
  });

  it("pruneDrafts 删除不在会话列表中的草稿键，保留现存会话与其他键", () => {
    saveDraft("s1", "保留");
    saveDraft("s2", "删除");
    saveDraft("s3", "也删除");
    window.localStorage.setItem("owc-send-key", "enter");
    pruneDrafts(new Set(["s1"]));
    expect(loadDraft("s1")).toBe("保留");
    expect(loadDraft("s2")).toBeUndefined();
    expect(loadDraft("s3")).toBeUndefined();
    expect(window.localStorage.getItem("owc-send-key")).toBe("enter");
  });
});
