// Chat Composer 的按会话状态：文字草稿用 sessionStorage 恢复，图片附件仅留内存。
// 与工作台 owc-draft-* 隔离，避免工作台的会话列表修剪误删 Chat 草稿。
import { useCallback, useEffect } from "react";
import { createStore, useStore } from "../app/store";

export interface PendingImage {
  id: string;
  mediaType: string;
  /** ≤2MB 内嵌 base64；>2MB 时保留 File，发送前才上传换取 ref。 */
  data?: string;
  file?: File;
  /** data URL 预览（内嵌与上传路径统一读取，无 objectURL 生命周期）。 */
  previewUrl: string;
}

interface ComposerEntry {
  draft: string;
  images: PendingImage[];
}

type ComposerState = Record<string, ComposerEntry>;

const DRAFT_PREFIX = "owc-chat-draft-";
const NEW_SESSION_KEY = "new";
const EMPTY_IMAGES: PendingImage[] = [];
const store = createStore<ComposerState>({});

function storageKey(sessionKey: string): string {
  return `${DRAFT_PREFIX}${sessionKey}`;
}

function readDraft(sessionKey: string): string {
  try {
    const raw = window.sessionStorage.getItem(storageKey(sessionKey));
    if (raw === null) return "";
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return "";
  }
}

function writeDraft(sessionKey: string, draft: string): void {
  try {
    if (draft) window.sessionStorage.setItem(storageKey(sessionKey), JSON.stringify(draft));
    else window.sessionStorage.removeItem(storageKey(sessionKey));
  } catch {
    // 隐私模式/配额不足不影响内存中的编辑与发送。
  }
}

function ensureEntry(sessionKey: string): ComposerEntry {
  const existing = store.get()[sessionKey];
  if (existing) return existing;
  const entry: ComposerEntry = { draft: readDraft(sessionKey), images: [] };
  store.set({ [sessionKey]: entry });
  return entry;
}

export function useChatComposer(sessionId: string | undefined): {
  sessionKey: string;
  draft: string;
  images: PendingImage[];
  setDraft(value: string): void;
  setImages(value: PendingImage[] | ((previous: PendingImage[]) => PendingImage[])): void;
} {
  const sessionKey = sessionId ?? NEW_SESSION_KEY;
  useEffect(() => {
    ensureEntry(sessionKey);
  }, [sessionKey]);
  const entry = useStore(store, (state) => state[sessionKey]);
  // setter 按会话稳定：Composer 的 apiRef 注册 effect 不会每次击键重跑
  const setDraft = useCallback((value: string) => {
    const current = ensureEntry(sessionKey);
    if (current.draft === value) return;
    store.set({ [sessionKey]: { ...current, draft: value } });
    writeDraft(sessionKey, value);
  }, [sessionKey]);
  const setImages = useCallback((value: PendingImage[] | ((previous: PendingImage[]) => PendingImage[])) => {
    const current = ensureEntry(sessionKey);
    const images = typeof value === "function" ? value(current.images) : value;
    if (images === current.images) return;
    store.set({ [sessionKey]: { ...current, images } });
  }, [sessionKey]);
  return {
    sessionKey,
    draft: entry?.draft ?? "",
    images: entry?.images ?? EMPTY_IMAGES,
    setDraft,
    setImages,
  };
}

/** 首页直发建会话后，把临时 Composer 状态整体迁到真实 sessionId。 */
export function migrateChatComposer(fromKey: string, sessionId: string): void {
  if (fromKey === sessionId) return;
  const source = ensureEntry(fromKey);
  const target = store.get()[sessionId];
  const next = { ...store.get(), [sessionId]: target ?? source };
  delete next[fromKey];
  store.replace(next);
  writeDraft(sessionId, target?.draft ?? source.draft);
  writeDraft(fromKey, "");
}

/** 只清理本次已提交的原文和附件；发送等待期间的新输入/新附件保留。 */
export function clearSubmittedChatComposer(sessionKey: string, submittedDraft: string, submittedImageIds: ReadonlySet<string>): void {
  const current = ensureEntry(sessionKey);
  const draft = current.draft === submittedDraft ? "" : current.draft;
  const images = current.images.filter((image) => !submittedImageIds.has(image.id));
  store.set({ [sessionKey]: { draft, images } });
  writeDraft(sessionKey, draft);
}

export function discardChatComposer(sessionId: string): void {
  const next = { ...store.get() };
  delete next[sessionId];
  store.replace(next);
  writeDraft(sessionId, "");
}
