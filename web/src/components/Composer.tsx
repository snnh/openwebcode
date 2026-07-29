import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import type { ExtensionInfo, ModelProfile, SessionDetail, SkillInfo } from "../lib/contracts";
import { api, ApiError } from "../lib/api";
import { extractAttachmentPaths } from "../lib/attachments";
import type { PdfRenderOptions } from "../lib/pdf-to-images";
import type { SendKey } from "../lib/prefs";
import { nextRecentModel, recordRecentModel } from "../lib/recent-models";
import { Icon } from "./Icon";
import { ModelCapabilityBadges } from "./ModelCapabilityBadges";
import { useI18n } from "../i18n";

export interface PendingImage {
  mediaType: string;
  data: string;
  previewUrl: string;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Keep this client-side guard aligned with server/src/app.ts. It prevents an
// oversized PDF from being fully base64-encoded in the browser only to be
// rejected by the upload route.
const MAX_PDF_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

type PdfToImageExtension = Pick<ExtensionInfo, "enabled" | "config">;
type PdfToImageStatus = "loading" | "ready" | "unavailable";
type NoticeKind = "info" | "error";
type PdfProgress =
  | { stage: "uploading"; fileName: string }
  | { stage: "converting"; completed: number; total: number };

interface AttachmentTask {
  sessionId: string;
  generation: number;
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : undefined;
}

function pdfRenderOptions(config: Record<string, unknown>, room: number): PdfRenderOptions {
  const configuredPages = positiveInteger(config.maxPages);
  // 扩展配置来自可编辑 JSON；页数受附件槽位限制，画布参数再加保守上限。
  const dpi = positiveInteger(config.dpi, 300);
  const maxDimension = positiveInteger(config.maxDimension, 2048);
  return {
    maxPages: Math.min(room, configuredPages ?? room),
    ...(dpi === undefined ? {} : { dpi }),
    ...(maxDimension === undefined ? {} : { maxDimension }),
  };
}

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const previewUrl = String(reader.result);
      resolve({ mediaType: file.type, data: previewUrl.slice(previewUrl.indexOf(",") + 1), previewUrl });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read image"));
    reader.readAsDataURL(file);
  });
}

/** 服务端内置斜杠命令（app.ts 消息路由匹配），与技能/自定义命令一起参与补全 */
type Suggestion = SkillInfo & { builtin?: boolean };

/** @ 补全条目：文件与符号两类（0.4.0 Phase 2 §5.2，共用服务端索引缓存） */
type MentionItem =
  | { type: "file"; path: string }
  | { type: "symbol"; name: string; kind: string; path: string; line: number };

/** 索引状态："unavailable" 表示索引未建/未启用，已回退实时文件搜索 */
type MentionIndexStatus = "fresh" | "stale" | "building" | "missing" | "unavailable";

/** 符号条目选择后插入 `@路径:行号`，与 extractAttachmentPaths 的 `:行号` 剥离约定一致 */
function mentionInsertPath(item: MentionItem): string {
  return item.type === "symbol" ? `${item.path}:${item.line}` : item.path;
}

/**
 * @ 补全数据源：优先索引缓存（文件清单 + 符号），索引端点 409/501 时回退
 * complete-path 实时 glob（行为与索引上线前一致，用户无感）。符号查询失败只丢
 * 符号条目，不影响文件结果。
 */
async function loadMentionItems(sessionId: string, q: string): Promise<{ items: MentionItem[]; indexStatus: MentionIndexStatus }> {
  try {
    const filesRes = await api.workspaceFiles(sessionId, q);
    const items: MentionItem[] = filesRes.files.map((file) => ({ type: "file", path: file.path }));
    try {
      const symbolsRes = await api.workspaceSymbols(sessionId, q);
      for (const symbol of symbolsRes.symbols) {
        items.push({ type: "symbol", name: symbol.name, kind: symbol.kind, path: symbol.path, line: symbol.startLine });
      }
    } catch {
      // 符号索引不可用/查询失败：只降级掉符号条目
    }
    return { items, indexStatus: filesRes.indexStatus };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 501)) {
      const fallback = await api.completePath(sessionId, q);
      return { items: fallback.matches.map((match) => ({ type: "file", path: match.path })), indexStatus: "unavailable" };
    }
    throw error;
  }
}

/** 思考模式下拉的中文标签；value 保持英文枚举不变 */
const THINKING_LABEL: Record<string, [string, string]> = { adaptive: ["自适应", "Adaptive"], enabled: ["开启", "Enabled"], disabled: ["关闭", "Disabled"] };
const EFFORT_LABEL: Record<string, [string, string]> = {
  low: ["低", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高", "Extra high"],
  max: ["最大", "Maximum"],
};

export function Composer({ current, model, models, providers = [], pdfToImageExtension, pdfToImageStatus = "ready", imageCapabilitiesReady = true, draft, setDraft, onSend, onConfig, running, sendKey, skills, attachments, setAttachments, supportsImages, onNotice, sendPending = false, history = [], editingMessage, onCancelEdit }: {
  current: SessionDetail;
  model?: ModelProfile;
  models: ModelProfile[];
  providers?: string[];
  /** 官方 PDF 转图片扩展的持久化启用状态及渲染配置。 */
  pdfToImageExtension?: PdfToImageExtension;
  /** 扩展目录尚未返回时，不把未知状态误判成「已关闭」。 */
  pdfToImageStatus?: PdfToImageStatus;
  /** 模型目录尚未返回时，避免把未知图片能力误判成不支持。 */
  imageCapabilitiesReady?: boolean;
  draft: string;
  setDraft(value: string): void;
  onSend(behavior?: "start" | "steer" | "follow_up"): void;
  onConfig(body: Record<string, unknown>): void;
  running: boolean;
  /** 发送请求进行中：屏蔽重复提交（按钮禁用、Enter 不触发），运行中入队场景不受影响 */
  sendPending?: boolean;
  sendKey: SendKey;
  skills: SkillInfo[];
  attachments: PendingImage[];
  setAttachments(value: PendingImage[] | ((prev: PendingImage[]) => PendingImage[])): void;
  supportsImages: boolean;
  onNotice(message: string, kind?: NoticeKind): void;
  /** 输入历史（本会话已发送的用户消息，最新在前）：↑/↓ 回查，弹层打开时弹层优先 */
  history?: string[];
  /** 编辑重发状态（App 持有）：展示横幅，Esc/取消回调退出并恢复草稿；hadAttachments 提示附件不会随重发 */
  editingMessage?: { messageId: string; hadAttachments: boolean } | undefined;
  onCancelEdit?(): void;
}): ReactElement {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const attachmentsRef = useRef(attachments);
  const attachmentQueueRef = useRef(Promise.resolve());
  const pdfJobsRef = useRef(0);
  const pdfJobsTaskRef = useRef<AttachmentTask | undefined>(undefined);
  // Tasks outlive a render. Bind each one to this identity so an upload or a
  // PDF.js render started in session A can never update the global draft or
  // image attachments after the user switches to session B.
  const taskSessionRef = useRef<AttachmentTask>({ sessionId: current.id, generation: 0 });
  if (taskSessionRef.current.sessionId !== current.id) {
    taskSessionRef.current = { sessionId: current.id, generation: taskSessionRef.current.generation + 1 };
    attachmentQueueRef.current = Promise.resolve();
    pdfJobsRef.current = 0;
    pdfJobsTaskRef.current = undefined;
    // App clears the shared attachment state in an effect. Clear the local
    // reservation synchronously so a newly selected session cannot inherit it.
    attachmentsRef.current = [];
  }
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [pdfJobs, setPdfJobs] = useState(0);
  const [pdfProgress, setPdfProgress] = useState<PdfProgress | null>(null);
  const [queuedBehavior, setQueuedBehavior] = useState<"steer" | "follow_up">("steer");
  const [advancedConfigOpen, setAdvancedConfigOpen] = useState(false);
  // 输入历史回查：null = 未在回查；进入回查时把当前草稿暂存，回查到底（最新之后）恢复
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyStashRef = useRef("");
  // Ctrl+P 模型循环：提示文本短暂显示后由定时器移除；cycleBase 记录上次循环目标，
  // 使配置生效前连续按 Ctrl+P 仍能按列表顺序前进（外部改模型时以 props 为准并清空）
  const [modelCycleHint, setModelCycleHint] = useState<string | null>(null);
  const modelCycleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cycleBaseRef = useRef<{ provider: string; model: string } | null>(null);
  const pdfToImageEnabled = pdfToImageExtension?.enabled === true;

  useEffect(() => () => clearTimeout(modelCycleTimerRef.current), []);

  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => {
    attachmentQueueRef.current = Promise.resolve();
    pdfJobsRef.current = 0;
    pdfJobsTaskRef.current = undefined;
    setPdfJobs(0);
    setPdfProgress(null);
    // 会话切换：历史属于旧会话，退出回查状态
    setHistoryIndex(null);
  }, [current.id]);
  const isCurrentTask = useCallback((task: AttachmentTask): boolean => (
    taskSessionRef.current.sessionId === task.sessionId
    && taskSessionRef.current.generation === task.generation
  ), []);
  const currentTask = (): AttachmentTask => ({ ...taskSessionRef.current });
  const notifyTask = (task: AttachmentTask, message: string, kind: NoticeKind = "info"): void => {
    if (isCurrentTask(task)) onNotice(message, kind);
  };
  const updatePdfProgress = (task: AttachmentTask, progress: PdfProgress): void => {
    if (isCurrentTask(task)) setPdfProgress(progress);
  };
  // Ref identity flips synchronously during a session-switch render, so the
  // new session is never visually or functionally locked while effects reset
  // the old task's state on the following commit.
  const processingPdf = pdfJobs > 0 && pdfJobsTaskRef.current !== undefined && isCurrentTask(pdfJobsTaskRef.current);
  const writeDraft = useCallback((value: string): void => {
    draftRef.current = value;
    setDraft(value);
  }, [setDraft]);
  // 随内容自动增高，上限由 CSS max-height 控制
  useEffect(() => {
    const element = textareaRef.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [draft]);

  // 输入 /前缀 时呼出技能补全；Esc 暂时关闭，内容变化后重新打开
  const command = draft.match(/^\/([\w-]*)$/);
  const slashActive = command !== null && !dismissed;
  const builtinCommands: Suggestion[] = [
    { name: "clear", description: t("清空上下文（历史保留，可回滚）", "Clear context (retain history; reversible)"), source: "global", builtin: true },
    { name: "compact", description: t("压缩上下文（/compact tools 为规则压缩）", "Compact context (/compact tools uses rule-based compaction)"), source: "global", builtin: true },
    { name: "init", description: t("分析代码库并生成/更新 AGENTS.md", "Analyze the codebase and generate/update AGENTS.md"), source: "global", builtin: true },
    { name: "help", description: t("打开快捷键与命令速查", "Open the keyboard shortcuts and commands reference"), source: "global", builtin: true },
  ];
  const suggestions: Suggestion[] = command && !dismissed
    ? [...builtinCommands, ...skills].filter((skill) => skill.name.toLowerCase().startsWith(command[1]!.toLowerCase()))
    : [];
  const popupOpen = slashActive;
  const hasSuggestions = suggestions.length > 0;
  useEffect(() => {
    setDismissed(false);
    setActive(0);
  }, [draft]);

  // @文件引用补全：检测光标前 `@<partial>`，防抖 200ms 查询（优先索引缓存，409/501 回退 complete-path）
  const [mentionPartial, setMentionPartial] = useState<string | null>(null);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  // 索引状态非 fresh 时在弹层顶部给一行提示；null=尚未返回
  const [mentionIndexStatus, setMentionIndexStatus] = useState<MentionIndexStatus | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionFailed, setMentionFailed] = useState(false);
  // Esc 关闭后，draft 内容变化才重新打开（避免方向键移动光标反复触发）
  useEffect(() => { setMentionDismissed(false); }, [draft]);

  const updateMentionFromValue = useCallback((value: string, cursor: number, dismissed: boolean) => {
    if (dismissed) { setMentionPartial(null); return; }
    const before = value.slice(0, cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) { setMentionPartial(null); return; }
    const atIdx = before.length - match[0].length;
    // @ 必须在空白或行首之后（避免匹配 a@b 邮箱形态）
    if (atIdx > 0) {
      const prev = before[atIdx - 1];
      if (prev && !/\s/.test(prev)) { setMentionPartial(null); return; }
    }
    setMentionPartial(match[1]);
    setMentionActive(0);
  }, []);

  // 防抖调 loadMentionItems；partial 为空（仅 @ 无字符）不调 API
  useEffect(() => {
    if (mentionPartial === null || mentionPartial === "") {
      setMentionItems([]);
      setMentionIndexStatus(null);
      setMentionFailed(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      loadMentionItems(current.id, mentionPartial)
        .then((res) => { if (!cancelled) { setMentionItems(res.items.slice(0, 20)); setMentionIndexStatus(res.indexStatus); setMentionFailed(false); } })
        .catch(() => { if (!cancelled) { setMentionItems([]); setMentionIndexStatus(null); setMentionFailed(true); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mentionPartial, current.id]);

  const mentionOpen = !mentionDismissed && mentionPartial !== null && mentionPartial !== "";
const mentionHasMatches = mentionItems.length > 0;

  // 方向键移动激活项时滚动保持可见（仅弹层打开时执行）
  useEffect(() => {
    if (mentionOpen && mentionHasMatches) {
      document.getElementById(`mention-option-${mentionActive}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [mentionActive, mentionOpen, mentionHasMatches]);
  useEffect(() => {
    if (popupOpen && hasSuggestions) {
      document.getElementById(`skill-option-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [active, popupOpen, hasSuggestions]);

  const insertMention = useCallback((item: MentionItem): void => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, cursor);
    const after = draft.slice(cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) return;
    const startIdx = before.length - match[0].length;
    const replacement = `@${mentionInsertPath(item)} `;
    const next = draft.slice(0, startIdx) + replacement + after;
    writeDraft(next);
    setMentionPartial(null);
    setMentionItems([]);
    setMentionDismissed(false);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node) {
        const pos = startIdx + replacement.length;
        node.selectionStart = pos;
        node.selectionEnd = pos;
        node.focus();
      }
    });
  }, [draft, writeDraft]);

  const removeMention = (filePath: string): void => {
    const token = `@${filePath}`;
    const idx = draft.indexOf(token);
    if (idx < 0) return;
    let end = idx + token.length;
    // 草稿里可能带符号补全插入的 :行号 后缀，一并移除
    const suffix = draft.slice(end).match(/^:\d+/);
    if (suffix) end += suffix[0].length;
    if (draft[end] === " ") end += 1;
    writeDraft(draft.slice(0, idx) + draft.slice(end));
  };

  const mentionedPaths = extractAttachmentPaths(draft);

  const syncMention = (node: HTMLTextAreaElement): void => {
    updateMentionFromValue(node.value, node.selectionStart ?? node.value.length, mentionDismissed);
  };

  const pick = (skill: SkillInfo): void => {
    writeDraft(`/${skill.name} `);
    textareaRef.current?.focus();
  };

  const appendAttachments = (images: PendingImage[], task: AttachmentTask): number => {
    if (!isCurrentTask(task)) return 0;
    const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
    const accepted = images.slice(0, room);
    if (accepted.length === 0) return 0;
    // 先保留槽位，避免 PDF 和普通图片的异步读取互相超出上限。
    // ref 只在 updater 外提交这一次：StrictMode 会双调 updater，内部写 ref
    // 会导致重复追加、remainingAttachmentSlots 错乱。
    attachmentsRef.current = [...attachmentsRef.current, ...accepted];
    setAttachments((prev) => {
      // updater 必须保持纯函数。React may flush this state updater after a
      // session switch. Returning the new session's previous value prevents a
      // stale task from leaking an image across sessions; the session-switch
      // path resets attachmentsRef synchronously.
      if (!isCurrentTask(task)) return prev;
      const next = accepted.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length));
      return next.length > 0 ? [...prev, ...next] : prev;
    });
    return accepted.length;
  };

  const remainingAttachmentSlots = (task: AttachmentTask): number => (
    isCurrentTask(task) ? Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length) : 0
  );

  const appendUploadedPdfReference = (path: string, task: AttachmentTask): boolean => {
    if (!isCurrentTask(task)) return false;
    const currentDraft = draftRef.current;
    const separator = currentDraft && !/\s$/.test(currentDraft) ? " " : "";
    const inserted = `${separator}[PDF path: ${path}]`;
    const next = `${currentDraft}${inserted}`;
    writeDraft(next);
    updateMentionFromValue(next, next.length, mentionDismissed);
    requestAnimationFrame(() => {
      if (!isCurrentTask(task)) return;
      const node = textareaRef.current;
      if (node) {
        node.selectionStart = next.length;
        node.selectionEnd = next.length;
        node.focus();
      }
    });
    return true;
  };

  const convertPdf = async (file: File, path: string, room: number, task: AttachmentTask): Promise<void> => {
    updatePdfProgress(task, { stage: "converting", completed: 0, total: room });
    try {
      // 仅在官方扩展启用且用户实际添加 PDF 时加载 PDF.js/worker。
      const { renderPdfToImages } = await import("../lib/pdf-to-images");
      if (!isCurrentTask(task)) return;
      const result = await renderPdfToImages(file, pdfRenderOptions(pdfToImageExtension?.config ?? {}, room), (progress) => updatePdfProgress(task, { stage: "converting", ...progress }));
      if (!isCurrentTask(task)) return;
      const added = appendAttachments(result.images, task);
      if (result.truncated || added < result.images.length) {
        const total = result.totalPages > 0 ? `/${result.totalPages}` : "";
        notifyTask(task, t(
          `PDF「${file.name || "文档"}」仅转换前 ${added}${total} 页（附件最多 ${MAX_ATTACHMENTS} 张）`,
          `Only the first ${added}${total} pages of “${file.name || "PDF"}” were converted (up to ${MAX_ATTACHMENTS} attachments).`,
        ));
      }
    } catch (error) {
      if (!isCurrentTask(task)) return;
      appendUploadedPdfReference(path, task);
      const detail = error instanceof Error && error.message ? `：${error.message}` : "";
      const englishDetail = error instanceof Error && error.message ? `: ${error.message}` : "";
      notifyTask(task, t(
        `PDF「${file.name || "文档"}」转换失败${detail}；已插入工作区路径引用。`,
        `Could not convert PDF “${file.name || "PDF"}”${englishDetail}; a workspace path reference was inserted.`,
      ), "error");
    }
  };

  const uploadPdf = async (file: File, task: AttachmentTask): Promise<string | undefined> => {
    updatePdfProgress(task, { stage: "uploading", fileName: file.name || "PDF" });
    try {
      const uploaded = await api.uploadPdf(task.sessionId, file);
      if (!isCurrentTask(task)) return undefined;
      if (!uploaded.path) throw new Error("Server did not return a workspace path");
      return uploaded.path;
    } catch (error) {
      if (!isCurrentTask(task)) return undefined;
      const detail = error instanceof Error && error.message ? `：${error.message}` : "";
      const englishDetail = error instanceof Error && error.message ? `: ${error.message}` : "";
      notifyTask(task, t(
        `PDF「${file.name || "文档"}」保存到工作区失败${detail}`,
        `Could not save PDF “${file.name || "PDF"}” to the workspace${englishDetail}`,
      ), "error");
      return undefined;
    }
  };

  const processPdf = async (file: File, task: AttachmentTask): Promise<void> => {
    // 不论扩展开关，先把用户选择的 PDF 保存到当前会话工作区，避免依赖浏览器不可用的本机路径。
    const path = await uploadPdf(file, task);
    if (!path || !isCurrentTask(task)) return;
    if (!pdfToImageEnabled) {
      appendUploadedPdfReference(path, task);
      notifyTask(task, t(
        `PDF 已保存到工作区「${path}」；PDF 转图片扩展未启用，已插入路径引用。`,
        `PDF was saved to “${path}”. The PDF-to-image extension is disabled, so a path reference was inserted.`,
      ));
      return;
    }
    if (!supportsImages) {
      appendUploadedPdfReference(path, task);
      notifyTask(task, t(
        `PDF 已保存到工作区「${path}」，但当前模型不支持图片输入，已插入路径引用。`,
        `PDF was saved to “${path}”, but the current model does not support image input, so a path reference was inserted.`,
      ));
      return;
    }
    const room = remainingAttachmentSlots(task);
    if (room <= 0) {
      appendUploadedPdfReference(path, task);
      notifyTask(task, t(
        `PDF 已保存到工作区「${path}」，但最多附带 ${MAX_ATTACHMENTS} 张图片，已插入路径引用。`,
        `PDF was saved to “${path}”, but the ${MAX_ATTACHMENTS}-image attachment limit leaves no room to convert it, so a path reference was inserted.`,
      ));
      return;
    }
    await convertPdf(file, path, room, task);
  };

  const addFiles = (files: File[]): void => {
    let pdfAvailabilityNoticeShown = false;
    let pdfSizeNoticeShown = false;
    const attachmentFiles = files.filter((file) => {
      if (!isImage(file) && !isPdf(file)) return false;
      if (!isPdf(file)) return true;
      if (file.size > MAX_PDF_UPLOAD_BYTES) {
        if (!pdfSizeNoticeShown) {
          onNotice(t("PDF 超过 20MB 限制，未开始上传", "The PDF exceeds the 20 MB limit and was not uploaded."), "error");
          pdfSizeNoticeShown = true;
        }
        return false;
      }
      if (pdfToImageStatus !== "ready") {
        if (!pdfAvailabilityNoticeShown) {
          onNotice(t(
            pdfToImageStatus === "loading" ? "正在读取 PDF 扩展状态，请稍候再添加 PDF" : "无法读取 PDF 扩展状态，暂不能添加 PDF",
            pdfToImageStatus === "loading" ? "PDF extension status is still loading. Please try adding the PDF again shortly." : "PDF extension status is unavailable, so PDFs cannot be added yet.",
          ), "error");
          pdfAvailabilityNoticeShown = true;
        }
        return false;
      }
      if (pdfToImageEnabled && !imageCapabilitiesReady) {
        if (!pdfAvailabilityNoticeShown) {
          onNotice(t("正在读取当前模型的图片能力，请稍候再添加 PDF", "The current model's image capability is still loading. Please try adding the PDF again shortly."), "error");
          pdfAvailabilityNoticeShown = true;
        }
        return false;
      }
      return true;
    });
    if (attachmentFiles.length === 0) return;
    const task = currentTask();
    const hasPdf = attachmentFiles.some(isPdf);
    if (hasPdf) {
      pdfJobsTaskRef.current = task;
      pdfJobsRef.current += 1;
      setPdfJobs(pdfJobsRef.current);
      updatePdfProgress(task, { stage: "uploading", fileName: "" });
    }

    attachmentQueueRef.current = attachmentQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrentTask(task)) return;
        for (const file of attachmentFiles) {
          if (!isCurrentTask(task)) return;
          if (isPdf(file)) {
            await processPdf(file, task);
            continue;
          }
          if (!supportsImages) {
            notifyTask(task, t("当前模型不支持图片输入", "The current model does not support image input"), "error");
            continue;
          }
          const room = remainingAttachmentSlots(task);
          if (room <= 0) {
            notifyTask(task, t(`最多附带 ${MAX_ATTACHMENTS} 张图片`, `You can attach up to ${MAX_ATTACHMENTS} images`), "error");
            break;
          }
          if (!IMAGE_TYPES.has(file.type)) {
            notifyTask(task, t(`仅支持 png/jpeg/webp/gif 图片（${file.type || "未知类型"}）`, `Only PNG, JPEG, WebP, and GIF images are supported (${file.type || "unknown type"})`), "error");
            continue;
          }
          if (file.size > MAX_IMAGE_BYTES) {
            notifyTask(task, t(`图片「${file.name || "剪贴板图片"}」超过 5MB 限制`, `Image “${file.name || "clipboard image"}” exceeds the 5 MB limit`), "error");
            continue;
          }
          try {
            const image = await readImage(file);
            if (!isCurrentTask(task)) return;
            appendAttachments([image], task);
          } catch {
            notifyTask(task, t(`无法读取图片「${file.name || "剪贴板图片"}」`, `Could not read image “${file.name || "clipboard image"}”`), "error");
          }
        }
      })
      .finally(() => {
        if (!hasPdf || !isCurrentTask(task)) return;
        pdfJobsRef.current = Math.max(0, pdfJobsRef.current - 1);
        setPdfJobs(pdfJobsRef.current);
        if (pdfJobsRef.current === 0) {
          pdfJobsTaskRef.current = undefined;
          setPdfProgress(null);
        }
      });
  };

  const insertDraftAtSelection = (value: string, addWhitespaceAtBoundaries = false): void => {
    if (!value) return;
    const currentDraft = draftRef.current;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? currentDraft.length;
    const end = el?.selectionEnd ?? start;
    const before = currentDraft.slice(0, start);
    const after = currentDraft.slice(end);
    const prefix = addWhitespaceAtBoundaries && before && !/\s$/.test(before) ? " " : "";
    const suffix = addWhitespaceAtBoundaries && after && !/^\s/.test(after) ? " " : "";
    const inserted = `${prefix}${value}${suffix}`;
    const next = before + inserted + after;
    writeDraft(next);
    updateMentionFromValue(next, before.length + inserted.length, mentionDismissed);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node) {
        const pos = before.length + inserted.length;
        node.selectionStart = pos;
        node.selectionEnd = pos;
        node.focus();
      }
    });
  };

  const onPaste = (event: ReactClipboardEvent): void => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.some((file) => isImage(file) || isPdf(file))) return;
    event.preventDefault();
    addFiles(files);
    // 剪贴板常同时携带文本（路径/说明），插入光标处而非静默丢弃
    const text = event.clipboardData?.getData("text") ?? "";
    insertDraftAtSelection(text);
  };

  const onDrop = (event: ReactDragEvent): void => {
    if ([...(event.dataTransfer?.files ?? [])].some((file) => isImage(file) || isPdf(file))) {
      event.preventDefault();
      addFiles([...event.dataTransfer.files]);
    }
  };

  const selectableModels = models.filter((item) => providers.includes(item.provider));
  const selectedModel = selectableModels.find((item) => item.provider === current.provider && item.id === current.model) ?? model;
  const modelSelection = JSON.stringify([current.provider, current.model]);
  const supportedThinking = selectedModel?.capabilities.thinking ?? [];
  const efforts = selectedModel?.capabilities.effort ?? [];
  // 思考模式和力度合为一个选择器。无 thinking 枚举但支持 effort 的模型以「默认」
  // 表示不显式下发 reasoning_effort；完全不支持时退化为禁用的「关闭」。
  const thinkingChoices: Array<{ value: string; label: [string, string] }> = [];
  if (supportedThinking.includes("disabled")) thinkingChoices.push({ value: "mode:disabled", label: THINKING_LABEL.disabled! });
  if (supportedThinking.length === 0 && efforts.length > 0) thinkingChoices.push({ value: "default", label: ["默认", "Default"] });
  for (const mode of supportedThinking) {
    if (mode !== "disabled") thinkingChoices.push({ value: `mode:${mode}`, label: THINKING_LABEL[mode] ?? [mode, mode] });
  }
  for (const effort of efforts) thinkingChoices.push({ value: `effort:${effort}`, label: EFFORT_LABEL[effort] ?? [effort, effort] });
  if (thinkingChoices.length === 0) thinkingChoices.push({ value: "mode:disabled", label: THINKING_LABEL.disabled! });
  const hasActiveThinkingMode = supportedThinking.some((mode) => mode !== "disabled");
  const thinkingExplicitlyOff = hasActiveThinkingMode
    && supportedThinking.includes("disabled")
    && (!current.thinking || current.thinking === "disabled");
  const thinkingSelection = thinkingExplicitlyOff
    ? "mode:disabled"
    : current.effort && efforts.includes(current.effort)
      ? `effort:${current.effort}`
      : current.thinking && supportedThinking.includes(current.thinking)
        ? `mode:${current.thinking}`
        : thinkingChoices[0]!.value;
  const thinkingControlSupported = hasActiveThinkingMode || efforts.length > 0;
  const selectionUnavailable = current.provider !== "" && !selectableModels.some((item) => item.provider === current.provider && item.id === current.model);

  // props 里的模型实际变化（下拉选择/会话切换/配置生效）时，循环基准回到 props；
  // 配置生效前的重渲染（如提示文本更新）不清空基准，保证连续 Ctrl+P 按列表顺序前进
  const propsModelRef = useRef({ provider: current.provider, model: current.model });
  if (propsModelRef.current.provider !== current.provider || propsModelRef.current.model !== current.model) {
    propsModelRef.current = { provider: current.provider, model: current.model };
    cycleBaseRef.current = null;
  }

  /** Ctrl+P 在最近使用的模型间循环（pi-agent 风格）。返回 false 表示不拦截按键（列表不足 2 条）。 */
  const cycleModel = (): boolean => {
    const base = cycleBaseRef.current ?? { provider: current.provider, model: current.model };
    const next = nextRecentModel(base);
    if (!next) return false;
    cycleBaseRef.current = next;
    const profile = selectableModels.find((item) => item.provider === next.provider && item.id === next.model);
    const config: Record<string, unknown> = { provider: next.provider, model: next.model };
    // 与下拉切换一致：目标模型不支持当前 thinking/effort 时在同一请求中清除
    if (profile) {
      if (current.thinking && !profile.capabilities.thinking.includes(current.thinking)) config.thinking = null;
      if (current.effort && !profile.capabilities.effort.includes(current.effort)) config.effort = null;
    }
    onConfig(config);
    clearTimeout(modelCycleTimerRef.current);
    setModelCycleHint(t(`已切换模型：${next.model}【${next.provider}】`, `Switched model: ${next.model}【${next.provider}】`));
    modelCycleTimerRef.current = setTimeout(() => setModelCycleHint(null), 2000);
    return true;
  };

  return (
    <footer className="composer" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf"
        multiple
        hidden
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {attachments.length > 0 && (
        <div className="attachment-strip" aria-label={t("图片附件", "Image attachments")}>
          {attachments.map((image, index) => (
            <span className="attachment" key={`${index}-${image.data.length}`}>
              <img src={image.previewUrl} alt={t(`附件 ${index + 1}`, `Attachment ${index + 1}`)} />
              <button
                className="attachment-remove"
                aria-label={t(`移除附件 ${index + 1}`, `Remove attachment ${index + 1}`)}
                onClick={() => setAttachments((prev) => prev.filter((_, item) => item !== index))}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {editingMessage && (
        <div className="composer-editing-banner" role="status">
          <Icon name="edit" size={12} />
          <span className="composer-editing-text">
            {t("正在编辑早前消息", "Editing an earlier message")}
            {editingMessage.hadAttachments ? t("（原消息的附件不会重发，仅发送文本）", " (attachments from the original message will not be resent; text only)") : ""}
          </span>
          <button type="button" className="btn small" onClick={() => onCancelEdit?.()}>
            {t("取消", "Cancel")}
          </button>
        </div>
      )}
      <div className="composer-input">
        {popupOpen && (
          <ul id="skill-listbox" className="skill-popup" role="listbox" aria-label={t("技能建议", "Skill suggestions")}>
            {hasSuggestions ? suggestions.map((skill, index) => (
              <li key={skill.name}>
                <button
                  type="button"
                  role="option"
                  id={`skill-option-${index}`}
                  aria-selected={index === active}
                  className={index === active ? "active" : ""}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(skill);
                  }}
                >
                  <span className="skill-name">/{skill.name}</span>
                  <span className="skill-desc">{skill.description}</span>
                  <span className="skill-source">{skill.builtin ? t("内置", "Built-in") : skill.source === "project" ? t("项目", "Project") : t("全局", "Global")}</span>
                </button>
              </li>
            )) : (
              <li className="skill-empty"><span className="skill-desc">{t("无匹配命令（内置 /clear、/compact；技能在 skills/ 放 SKILL.md；按 Esc 关闭）", "No matching command (built-ins: /clear, /compact; place SKILL.md under skills/; press Esc to close)")}</span></li>
            )}
          </ul>
        )}
        {mentionOpen && (
          <ul id="mention-listbox" className="mention-popup" role="listbox" aria-label={t("文件引用建议", "File reference suggestions")}>
            {mentionIndexStatus !== null && mentionIndexStatus !== "fresh" && (
              // 索引滞后/构建中/不可用（已回退实时搜索）的一行状态提示
              <li className="mention-status" aria-live="polite"><span>
                {mentionIndexStatus === "stale"
                  ? t("索引滞后：结果可能不是最新", "Index is stale: results may be outdated")
                  : mentionIndexStatus === "building"
                    ? t("索引构建中：结果可能不完整", "Index is building: results may be incomplete")
                    : t("索引未建或不可用：已回退实时文件搜索", "Index unavailable: fell back to live file search")}
              </span></li>
            )}
            {mentionHasMatches ? mentionItems.map((item, index) => (
              <li key={item.type === "symbol" ? `s:${item.path}:${item.line}:${item.name}` : `f:${item.path}`}>
                <button
                  type="button"
                  role="option"
                  id={`mention-option-${index}`}
                  aria-selected={index === mentionActive}
                  className={index === mentionActive ? "active" : ""}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertMention(item);
                  }}
                >
                  {item.type === "symbol" ? (
                    <>
                      <span className="mention-kind">{item.kind}</span>
                      <span className="mention-path">{item.name}</span>
                      <span className="mention-loc">{item.path}:{item.line}</span>
                    </>
                  ) : (
                    <>
                      <Icon name="file" size={11} />
                      <span className="mention-path">{item.path}</span>
                    </>
                  )}
                </button>
              </li>
            )) : (
              <li className="mention-empty"><span className="mention-path">{mentionFailed ? t("文件列表加载失败（继续输入重试，或按 Esc 关闭）", "Could not load files (keep typing to retry, or press Esc to close)") : t("无匹配文件（继续输入或按 Esc 关闭）", "No matching files (keep typing or press Esc to close)")}</span></li>
            )}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          id="composer-input"
          rows={2}
          value={draft}
          aria-label={t("消息输入框；输入 @ 可引用工作区文件", "Message input; type @ to reference workspace files")}
          role="combobox"
          aria-expanded={mentionOpen || popupOpen}
          aria-controls={mentionOpen ? "mention-listbox" : popupOpen ? "skill-listbox" : undefined}
          aria-activedescendant={
            mentionOpen
              ? (mentionHasMatches ? `mention-option-${mentionActive}` : undefined)
              : popupOpen && hasSuggestions ? `skill-option-${active}` : undefined
          }
          aria-autocomplete="list"
          onChange={(event) => {
            // 用户编辑（非回查写入）即退出回查：当前文本成为新的编辑起点
            if (historyIndex !== null) setHistoryIndex(null);
            writeDraft(event.target.value);
            syncMention(event.target);
          }}
          onSelect={(event) => syncMention(event.currentTarget)}
          onClick={(event) => syncMention(event.currentTarget)}
          onKeyUp={(event) => syncMention(event.currentTarget)}
          onPaste={onPaste}
          onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
            if (mentionOpen) {
              if (mentionHasMatches) {
                const count = mentionItems.length;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionActive((value) => (value + 1) % count);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionActive((value) => (value - 1 + count) % count);
                  return;
                }
              }
              // 补全打开期间 Enter/Tab 一律拦截：有匹配则选中；无匹配（防抖加载中或真空）则关闭补全，避免误发送半成品
              if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                if (mentionHasMatches) {
                  insertMention(mentionItems[Math.min(mentionActive, mentionItems.length - 1)]!);
                } else {
                  setMentionDismissed(true);
                  setMentionPartial(null);
                }
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionDismissed(true);
                setMentionPartial(null);
                return;
              }
            }
            if (popupOpen && hasSuggestions) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => (value + 1) % suggestions.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => (value - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                pick(suggestions[Math.min(active, suggestions.length - 1)]!);
                return;
              }
            }
            if (popupOpen && (event.key === "Tab" || event.key === "Enter")) {
              // 无技能建议时同样拦截 Enter：关闭补全而非发送
              event.preventDefault();
              setDismissed(true);
              return;
            }
            if (popupOpen && event.key === "Escape") {
              event.preventDefault();
              setDismissed(true);
              return;
            }
            // 输入历史回查：光标在首行（或输入为空）且弹层已让行后，↑ 逐条回退、↓ 前进，
            // 回查到底（最新之后）恢复进入时暂存的草稿；修饰键组合与输入法组合中（CJK IME 用 ↑/↓ 选候选）不触发
            if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
              if (event.key === "ArrowUp" && history.length > 0) {
                const node = event.currentTarget;
                const onFirstLine = historyIndex !== null || !node.value.slice(0, node.selectionStart ?? 0).includes("\n");
                if (onFirstLine) {
                  event.preventDefault();
                  if (historyIndex === null) historyStashRef.current = draftRef.current;
                  const next = Math.min((historyIndex ?? -1) + 1, history.length - 1);
                  if (next !== historyIndex) {
                    setHistoryIndex(next);
                    writeDraft(history[next]!);
                    requestAnimationFrame(() => {
                      const el = textareaRef.current;
                      if (el) { el.selectionStart = el.value.length; el.selectionEnd = el.value.length; }
                    });
                  }
                  return;
                }
              }
              if (event.key === "ArrowDown" && historyIndex !== null) {
                event.preventDefault();
                if (historyIndex === 0) {
                  setHistoryIndex(null);
                  writeDraft(historyStashRef.current);
                } else {
                  setHistoryIndex(historyIndex - 1);
                  writeDraft(history[historyIndex - 1]!);
                }
                requestAnimationFrame(() => {
                  const el = textareaRef.current;
                  if (el) { el.selectionStart = el.value.length; el.selectionEnd = el.value.length; }
                });
                return;
              }
            }
            // 编辑重发中 Esc 取消（补全弹层的 Esc 已在上方拦截返回，不冲突）
            if (editingMessage && event.key === "Escape") {
              event.preventDefault();
              onCancelEdit?.();
              return;
            }
            // Ctrl+P 在最近使用的模型间循环；输入法组合中忽略；列表不足 2 条时放行浏览器默认行为
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (event.key === "p" || event.key === "P")) {
              if (event.nativeEvent.isComposing) return;
              if (cycleModel()) event.preventDefault();
              return;
            }
            // 输入法组合中的 Enter 不触发发送；发送键可在设置中切换
            if (event.nativeEvent.isComposing || event.key !== "Enter") return;
            const shouldSend = sendKey === "enter"
              ? !event.shiftKey && !event.ctrlKey && !event.metaKey
              : event.ctrlKey || event.metaKey;
            if (shouldSend) {
              event.preventDefault();
              // 发送进行中忽略重复提交（运行中入队场景仍允许，由 running 控制）
              if (!sendPending && !processingPdf) { setHistoryIndex(null); onSend(); }
            }
          }}
          placeholder={running
            ? t("向正在执行的作业补充指令…", "Add instructions to the running job…")
            : sendKey === "enter" ? t("描述要完成的编码任务…（Enter 发送，Shift+Enter 换行，@ 引用文件）", "Describe a coding task… (Enter to send, Shift+Enter for a new line, @ to reference files)") : t("描述要完成的编码任务…（Ctrl+Enter 发送，@ 引用文件）", "Describe a coding task… (Ctrl+Enter to send, @ to reference files)")}
        />
        <button
          type="button"
          className="icon-btn composer-attach"
          disabled={processingPdf}
          aria-label={t("添加图片或 PDF", "Add image or PDF")}
          title={t("添加图片或 PDF", "Add image or PDF")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="upload" size={14} />
        </button>
        {running && (
          <select
            className="queue-behavior"
            value={queuedBehavior}
            onChange={(event) => setQueuedBehavior(event.target.value as "steer" | "follow_up")}
            aria-label={t("运行中消息行为", "Message behavior while running")}
          >
            <option value="steer">{t("本轮补充", "Steer current run")}</option>
            <option value="follow_up">{t("完成后续跑", "Run after completion")}</option>
          </select>
        )}
        <button
          className="btn primary send"
          disabled={!draft.trim() || sendPending || processingPdf}
          title={processingPdf ? t("正在处理 PDF…", "Processing PDF…") : sendPending ? t("发送中…", "Sending…") : undefined}
          onClick={() => onSend(running ? queuedBehavior : "start")}
        >
          <Icon name="send" size={13} />
          {editingMessage ? t("重发", "Resend") : draft.trimStart().startsWith("!") ? t("运行", "Run") : running ? queuedBehavior === "follow_up" ? t("完成后续跑", "Run after") : t("加入队列", "Queue") : t("发送", "Send")}
        </button>
      </div>
      {mentionedPaths.length > 0 && (
        <div className="mention-strip" aria-label={t("文件引用", "File references")}>
          {mentionedPaths.map((filePath) => (
            <span className="mention-chip" key={filePath}>
              <Icon name="file" size={10} />
              <span className="mention-chip-path">@{filePath}</span>
              <button
                type="button"
                className="mention-remove"
                aria-label={t(`移除引用 @${filePath}`, `Remove reference @${filePath}`)}
                onClick={() => removeMention(filePath)}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {processingPdf && (
        <div className="composer-conversion" role="status" aria-live="polite">
          {pdfProgress?.stage === "converting"
            ? t(`正在将 PDF 转为图片（${pdfProgress.completed}/${pdfProgress.total}）…`, `Converting PDF to images (${pdfProgress.completed}/${pdfProgress.total})…`)
            : t(`正在保存 PDF${pdfProgress?.fileName ? `「${pdfProgress.fileName}」` : ""}到工作区…`, `Saving PDF${pdfProgress?.fileName ? ` “${pdfProgress.fileName}”` : ""} to the workspace…`)}
        </div>
      )}
      {pdfToImageStatus !== "ready" ? (
        <div className="composer-hint">{t(
          pdfToImageStatus === "loading" ? "PDF 扩展状态加载中；图片可正常添加，PDF 请稍候重试。" : "PDF 扩展状态不可用；图片可正常添加，PDF 暂不能添加。",
          pdfToImageStatus === "loading" ? "PDF extension status is loading; images can still be added, but please retry PDFs shortly." : "PDF extension status is unavailable; images can still be added, but PDFs are unavailable for now.",
        )}</div>
      ) : pdfToImageEnabled ? (
        supportsImages && <div className="composer-hint">{t("支持添加、粘贴或拖拽图片/PDF（≤4 张图片，每张 ≤5MB）；PDF 会转为图片；输入 @ 引用工作区文件", "Add, paste, or drop images/PDFs (up to 4 images, 5 MB each); PDFs are converted to images; type @ to reference workspace files")}</div>
      ) : (
        <div className="composer-hint">{t("PDF 转图片扩展未启用；PDF 会先保存到工作区，再插入其路径引用。", "The PDF-to-image extension is disabled; PDFs are saved to the workspace and inserted as path references.")}</div>
      )}
      {modelCycleHint && (
        <div className="composer-hint composer-model-cycle" role="status">{modelCycleHint}</div>
      )}
      <div className="config-row" aria-label={t("会话配置", "Session configuration")}>
        <div className="composer-config-main">
          <label>
            {t("模式", "Mode")}
            <select
              value={current.agentMode ?? "build"}
              disabled={running}
              onChange={(event) => onConfig({ agentMode: event.target.value === "build" ? null : "plan" })}
            >
              <option value="build">{t("构建模式（Build）", "Build")}</option>
              <option value="plan">{t("计划模式（Plan）", "Plan")}</option>
            </select>
          </label>
          <label className="composer-model-field">
            {t("模型", "Model")}
            <select value={modelSelection} disabled={running} onChange={(event) => {
              const next = selectableModels.find((item) => JSON.stringify([item.provider, item.id]) === event.target.value || item.id === event.target.value);
              if (next) {
                recordRecentModel(next.provider, next.id);
                const config: Record<string, unknown> = { provider: next.provider, model: next.id };
                // Submit the target model and any required reasoning cleanup in
                // one request.  This avoids a rejected intermediate state when
                // the current model's thinking/effort values are unsupported by
                // the newly selected profile.
                if (current.thinking && !next.capabilities.thinking.includes(current.thinking)) config.thinking = null;
                if (current.effort && !next.capabilities.effort.includes(current.effort)) config.effort = null;
                onConfig(config);
              }
            }}>
              {selectionUnavailable && current.model && <option value={modelSelection}>{`${current.model}【${current.provider}】 (${t("不可用", "unavailable")})`}</option>}
              {selectableModels.length > 0
                ? selectableModels.map((item) => {
                    const value = JSON.stringify([item.provider, item.id]);
                    return <option key={value} value={value}>{`${item.id}【${item.provider}】`}</option>;
                  })
                : current.model
                  ? <option value={modelSelection}>{`${current.model}【${current.provider}】`}</option>
                  : <option value="">{t("暂无可用模型", "No model available")}</option>}
            </select>
          </label>
          <label className="composer-thinking-field">
            {t("思考", "Thinking")}
            <select
              value={thinkingSelection}
              disabled={running || (selectedModel !== undefined && !thinkingControlSupported)}
              onChange={(event) => {
                const choice = event.target.value;
                if (choice === "default" || choice === "mode:disabled") {
                  onConfig({ thinking: null, effort: null });
                  return;
                }
                if (choice.startsWith("mode:")) {
                  onConfig({ thinking: choice.slice("mode:".length), effort: null });
                  return;
                }
                const effort = choice.slice("effort:".length);
                const activeThinking = current.thinking !== "disabled" && current.thinking && supportedThinking.includes(current.thinking)
                  ? current.thinking
                  : supportedThinking.includes("enabled")
                    ? "enabled"
                    : supportedThinking.includes("adaptive")
                      ? "adaptive"
                      : null;
                onConfig({ thinking: activeThinking, effort });
              }}
            >
              {thinkingChoices.map((choice) => <option key={choice.value} value={choice.value}>{t(...choice.label)}</option>)}
            </select>
          </label>
          <label>
            {t("权限", "Permissions")}
            <select
              value={current.permissionMode ?? "ask"}
              disabled={running}
              onChange={(event) => onConfig({ permissionMode: event.target.value })}
            >
              <option value="ask">{t("每次确认", "Ask every time")}</option>
              <option value="acceptEdits">{t("接受编辑", "Accept edits")}</option>
              <option value="yolo">YOLO</option>
            </select>
          </label>
          <button
            type="button"
            className={`composer-config-toggle${advancedConfigOpen ? " open" : ""}`}
            aria-expanded={advancedConfigOpen}
            aria-controls="composer-advanced-config"
            onClick={() => setAdvancedConfigOpen((value) => !value)}
          >
            <Icon name="settings" size={13} />
            {t("高级设置", "Advanced")}
            <Icon name={advancedConfigOpen ? "chevron-up" : "chevron-down"} size={12} />
          </button>
        </div>
        {advancedConfigOpen && (
          <div id="composer-advanced-config" className="composer-config-advanced">
            {selectedModel && (
              <div className="model-capability-summary" aria-label={t("所选模型能力", "Selected model capabilities")}>
                <span className="model-capability-summary-label">{t("模型能力", "Model capabilities")}</span>
                <ModelCapabilityBadges capabilities={selectedModel.capabilities} />
              </div>
            )}
          </div>
        )}
        {running && <span className="steering-hint">{t("运行中 · 发送将进入 Steering 队列", "Running · new messages enter the Steering queue")}</span>}
      </div>
    </footer>
  );
}
