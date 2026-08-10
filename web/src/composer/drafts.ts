import { useCallback, useEffect } from "react";
import { createStore, useStore } from "../app/store";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts";

/**
 * 每会话草稿与附件（内存 + localStorage 镜像，刷新不丢）。
 * 草稿经 lib/drafts 持久化（键 owc-draft-<sessionId>，空串等价清除）；附件仅存内存。
 * ChatView 发送时经 getDraft/getAttachments 读取，发送成功后调 clearComposerState。
 */

export interface PendingImage {
  mediaType: string;
  data: string;
  previewUrl: string;
}

interface ComposerEntry {
  draft: string;
  attachments: PendingImage[];
}

type ComposerState = Record<string, ComposerEntry>;

const EMPTY_ATTACHMENTS: PendingImage[] = [];

const composerStore = createStore<ComposerState>({});

/** 首次访问某会话时从 localStorage 镜像恢复草稿（幂等）。 */
function ensureEntry(sessionId: string): ComposerEntry {
  const existing = composerStore.get()[sessionId];
  if (existing) return existing;
  const entry: ComposerEntry = { draft: loadDraft(sessionId) ?? "", attachments: [] };
  composerStore.set({ [sessionId]: entry });
  return entry;
}

/** 挂载期间保持该会话条目已水合（刷新恢复；effect 内执行，避免渲染期写 store）。 */
function useComposerSession(sessionId: string | undefined): void {
  useEffect(() => {
    if (sessionId) ensureEntry(sessionId);
  }, [sessionId]);
}

export function getDraft(sessionId: string): string {
  return ensureEntry(sessionId).draft;
}

export function setDraftValue(sessionId: string, value: string): void {
  const entry = ensureEntry(sessionId);
  if (entry.draft === value) return;
  composerStore.set({ [sessionId]: { ...entry, draft: value } });
  // 差量写入：仅在内容变化时落盘；saveDraft 对空串执行清除
  saveDraft(sessionId, value);
}

export function useDraft(sessionId: string | undefined): [string, (value: string) => void] {
  useComposerSession(sessionId);
  const draft = useStore(composerStore, (state) => (sessionId ? state[sessionId]?.draft : undefined)) ?? "";
  const set = useCallback((value: string) => {
    if (sessionId) setDraftValue(sessionId, value);
  }, [sessionId]);
  return [draft, set];
}

/**
 * 只关心「草稿非空」布尔的订阅（如命令体系 when 上下文）：
 * 选择器返回布尔，内容变化但非空判定不变时 useSyncExternalStore 不触发重渲染，
 * 避免每次击键带着订阅整棵树重渲染。
 */
export function useDraftNonEmpty(sessionId: string | undefined): boolean {
  useComposerSession(sessionId);
  return useStore(composerStore, (state) => Boolean(sessionId && state[sessionId]?.draft.trim()));
}

export function getAttachments(sessionId: string): PendingImage[] {
  return ensureEntry(sessionId).attachments;
}

function setAttachmentsValue(sessionId: string, value: PendingImage[] | ((previous: PendingImage[]) => PendingImage[])): void {
  const entry = ensureEntry(sessionId);
  const next = typeof value === "function" ? value(entry.attachments) : value;
  if (next === entry.attachments) return;
  composerStore.set({ [sessionId]: { ...entry, attachments: next } });
}

export function useAttachments(sessionId: string | undefined): [PendingImage[], (value: PendingImage[] | ((previous: PendingImage[]) => PendingImage[])) => void] {
  useComposerSession(sessionId);
  const attachments = useStore(composerStore, (state) => (sessionId ? state[sessionId]?.attachments : undefined)) ?? EMPTY_ATTACHMENTS;
  const set = useCallback((value: PendingImage[] | ((previous: PendingImage[]) => PendingImage[])) => {
    if (sessionId) setAttachmentsValue(sessionId, value);
  }, [sessionId]);
  return [attachments, set];
}

/** 发送成功后清空该会话的草稿（含 localStorage 镜像）与附件 */
export function clearComposerState(sessionId: string): void {
  composerStore.set({ [sessionId]: { draft: "", attachments: [] } });
  clearDraft(sessionId);
}
