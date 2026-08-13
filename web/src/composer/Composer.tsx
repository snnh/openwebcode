import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import type { ModelProfile, SkillInfo } from "../lib/contracts";
import { api, ApiError } from "../lib/api";
import { extractAttachmentPaths } from "../lib/attachments";
import type { PdfRenderOptions } from "../lib/pdf-to-images";
import { nextRecentModel, recordRecentModel } from "../lib/recent-models";
import { deriveInputHistory } from "../lib/input-history";
import { clipboardFiles, dataUrlBase64, readFileAsDataUrl } from "../lib/file-data-url";
import { useAutosizeTextarea } from "../hooks/use-autosize-textarea";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import { useExtensionsQuery, useModelsQuery, useProvidersQuery, useSkillsQuery } from "../app/queries";
import { ui } from "../app/ui-store";
import { useSendKey } from "../app/prefs-store";
import type { ComposerProps } from "../chat/types";
import { useAttachments, useDraft, type PendingImage } from "./drafts";
import { AttachmentStrip, MentionStrip } from "./chips";
import { AgentModeMenu, EFFORT_LABEL, ModelMenu, PermissionModeMenu, Popover, THINKING_LABEL } from "./popovers";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 与 server/src/app.ts 上传路由对齐：避免超大 PDF 在浏览器端 base64 后才被拒。
const MAX_PDF_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
/** 全部 effort 档位（未声明模型的滑块全集；max/ultra 不翻译）。标签表见 popovers。 */
const EFFORT_ALL = ["low", "medium", "high", "xhigh", "max", "ultra"];

type PdfToImageStatus = "loading" | "ready" | "unavailable";
type NoticeKind = "info" | "error";
type PdfProgress =
  | { stage: "uploading"; fileName: string }
  | { stage: "converting"; completed: number; total: number };

/** 异步附件任务的身份：绑定发起时的会话与代数，会话切换后旧任务不再写 React 状态/发提示。 */
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
  // 扩展配置来自可编辑 JSON；页数受附件槽位限制，画布参数再加保守上限。
  const configuredPages = positiveInteger(config.maxPages);
  const dpi = positiveInteger(config.dpi, 300);
  const maxDimension = positiveInteger(config.maxDimension, 2048);
  return {
    maxPages: Math.min(room, configuredPages ?? room),
    ...(dpi === undefined ? {} : { dpi }),
    ...(maxDimension === undefined ? {} : { maxDimension }),
  };
}

function readImage(file: File): Promise<PendingImage> {
  return readFileAsDataUrl(file).then((previewUrl) => ({
    mediaType: file.type,
    data: dataUrlBase64(previewUrl),
    previewUrl,
  }));
}

/** 服务端内置斜杠命令（消息路由匹配），与技能一起参与 / 补全 */
type Suggestion = SkillInfo & { builtin?: boolean };

/** @ 补全条目：文件与符号两类（共用服务端索引缓存） */
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
 * complete-path 实时 glob。符号查询失败只丢符号条目，不影响文件结果。
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

/**
 * 输入区（功能对等旧 components/Composer.tsx，数据全部自取）：
 * props 仅跨组件契约 ComposerProps；草稿/附件按会话隔离于 drafts store，
 * 模型/技能/扩展走 react-query，sendKey 走 prefs-store，提示走 ui.notify。
 * ChatView 发送时经 getDraft/getAttachments 取内容，成功后调 clearComposerState。
 */
export function Composer({ session, running, onSend, onConfig, editingMessage, onCancelEdit }: ComposerProps): ReactElement {
  const { t } = useI18n();
  const [draft, setDraft] = useDraft(session.id);
  const [attachments, setAttachments] = useAttachments(session.id);
  const sendKey = useSendKey();
  const modelsQuery = useModelsQuery();
  const providersQuery = useProvidersQuery();
  const skillsQuery = useSkillsQuery(session.id);
  const extensionsQuery = useExtensionsQuery();
  const models = modelsQuery.data ?? [];
  const providers = providersQuery.data ?? [];
  const skills = useMemo(() => skillsQuery.data?.skills ?? [], [skillsQuery.data]);
  // 模型目录未返回时不把未知图片能力误判成不支持（仅用于 PDF 转图前的等待提示）
  const imageCapabilitiesReady = !modelsQuery.isPending;
  const currentModel = models.find((item) => item.provider === session.provider && item.id === session.model);
  const pdfToImageStatus: PdfToImageStatus = extensionsQuery.isPending ? "loading" : extensionsQuery.isError ? "unavailable" : "ready";
  const pdfToImageExtension = extensionsQuery.data?.find((extension) => extension.id === "pdf-to-image");
  const pdfToImageEnabled = pdfToImageExtension?.enabled === true;
  // 视觉工具扩展启用且配置了视觉模型时，主模型不支持视觉也允许添加图片：
  // 扩展会把图片描述为文字注入主模型上下文。
  const visionToolsExtension = extensionsQuery.data?.find((extension) => extension.id === "vision-tools");
  const visionBridgeActive = visionToolsExtension?.enabled === true
    && typeof visionToolsExtension.config?.model === "string"
    && visionToolsExtension.config.model.trim() !== "";
  const supportsImages = (currentModel?.capabilities.modalities?.includes("image") ?? false) || visionBridgeActive;
  const history = useMemo(() => deriveInputHistory(session.messages), [session.messages]);
  const notify = useCallback((message: string, kind: NoticeKind = "info"): void => ui.notify(message, kind), []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const attachmentsRef = useRef(attachments);
  const attachmentQueueRef = useRef(Promise.resolve());
  const pdfJobsRef = useRef(0);
  // 任务比渲染长寿：绑定会话身份，A 会话发起的上传/转图不会在切到 B 后写 B 的 React 状态。
  const taskSessionRef = useRef<AttachmentTask>({ sessionId: session.id, generation: 0 });
  if (taskSessionRef.current.sessionId !== session.id) {
    taskSessionRef.current = { sessionId: session.id, generation: taskSessionRef.current.generation + 1 };
    attachmentQueueRef.current = Promise.resolve();
    pdfJobsRef.current = 0;
    // 附件按会话隔离在 store 中，新会话的清单即当前值，同步重挂 ref
    attachmentsRef.current = attachments;
  }
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [pdfJobs, setPdfJobs] = useState(0);
  const [pdfProgress, setPdfProgress] = useState<PdfProgress | null>(null);
  const [queuedBehavior, setQueuedBehavior] = useState<"steer" | "follow_up">("steer");
  const [queueMenuOpen, setQueueMenuOpen] = useState(false);
  // 输入历史回查：null = 未在回查；进入回查时把当前草稿暂存，回查到底（最新之后）恢复
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyStashRef = useRef("");
  // Ctrl+P 模型循环：提示文本短暂显示后由定时器移除；cycleBase 记录上次循环目标，
  // 使配置生效前连续按 Ctrl+P 仍能按列表顺序前进（外部改模型时以会话值为准并清空）
  const [modelCycleHint, setModelCycleHint] = useState<string | null>(null);
  const modelCycleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cycleBaseRef = useRef<{ provider: string; model: string } | null>(null);
  // PDF 提示可关闭：签名含扩展状态/启用位，状态变化后签名不同，提示重新出现
  const pdfHintSignature = `${pdfToImageStatus}.${pdfToImageEnabled ? "enabled" : "disabled"}`;
  const [pdfHintDismissed, setPdfHintDismissed] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem("owc.pdf-hint-dismissed");
    } catch {
      return null;
    }
  });
  const dismissPdfHint = (): void => {
    setPdfHintDismissed(pdfHintSignature);
    try {
      window.localStorage.setItem("owc.pdf-hint-dismissed", pdfHintSignature);
    } catch {
      // 持久化失败不影响使用
    }
  };

  useEffect(() => () => clearTimeout(modelCycleTimerRef.current), []);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => {
    setPdfJobs(0);
    setPdfProgress(null);
    // 会话切换：历史属于旧会话，退出回查状态
    setHistoryIndex(null);
  }, [session.id]);

  const isCurrentTask = useCallback((task: AttachmentTask): boolean => (
    taskSessionRef.current.sessionId === task.sessionId
    && taskSessionRef.current.generation === task.generation
  ), []);
  const currentTask = (): AttachmentTask => ({ ...taskSessionRef.current });
  const notifyTask = (task: AttachmentTask, message: string, kind: NoticeKind = "info"): void => {
    if (isCurrentTask(task)) notify(message, kind);
  };
  const updatePdfProgress = (task: AttachmentTask, progress: PdfProgress): void => {
    if (isCurrentTask(task)) setPdfProgress(progress);
  };
  const processingPdf = pdfJobs > 0;
  const writeDraft = useCallback((value: string): void => {
    draftRef.current = value;
    setDraft(value);
  }, [setDraft]);

  // 随内容自动增高，上限由 CSS max-height 控制；达到 max-height 出现真实溢出后才放开滚动
  useAutosizeTextarea(textareaRef, draft);

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

  const updateMentionFromValue = useCallback((value: string, cursor: number, wasDismissed: boolean): void => {
    if (wasDismissed) { setMentionPartial(null); return; }
    const before = value.slice(0, cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) { setMentionPartial(null); return; }
    const atIdx = before.length - match[0].length;
    // @ 必须在空白或行首之后（避免匹配 a@b 邮箱形态）
    if (atIdx > 0) {
      const prev = before[atIdx - 1];
      if (prev && !/\s/.test(prev)) { setMentionPartial(null); return; }
    }
    setMentionPartial(match[1] ?? "");
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
      loadMentionItems(session.id, mentionPartial)
        .then((res) => { if (!cancelled) { setMentionItems(res.items.slice(0, 20)); setMentionIndexStatus(res.indexStatus); setMentionFailed(false); } })
        .catch(() => { if (!cancelled) { setMentionItems([]); setMentionIndexStatus(null); setMentionFailed(true); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mentionPartial, session.id]);

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
    // ref 只在 updater 外提交这一次：StrictMode 双调 updater 时内部写 ref 会导致重复追加。
    attachmentsRef.current = [...attachmentsRef.current, ...accepted];
    setAttachments((prev) => {
      // updater 必须保持纯函数；会话已切换时不再追加（任务守卫挡掉陈旧提交）
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
    const next = `${currentDraft}${separator}[PDF path: ${path}]`;
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
          notify(t("PDF 超过 20MB 限制，未开始上传", "The PDF exceeds the 20 MB limit and was not uploaded."), "error");
          pdfSizeNoticeShown = true;
        }
        return false;
      }
      if (pdfToImageStatus !== "ready") {
        if (!pdfAvailabilityNoticeShown) {
          notify(t(
            pdfToImageStatus === "loading" ? "正在读取 PDF 扩展状态，请稍候再添加 PDF" : "无法读取 PDF 扩展状态，暂不能添加 PDF",
            pdfToImageStatus === "loading" ? "PDF extension status is still loading. Please try adding the PDF again shortly." : "PDF extension status is unavailable, so PDFs cannot be added yet.",
          ), "error");
          pdfAvailabilityNoticeShown = true;
        }
        return false;
      }
      if (pdfToImageEnabled && !imageCapabilitiesReady) {
        if (!pdfAvailabilityNoticeShown) {
          notify(t("正在读取当前模型的图片能力，请稍候再添加 PDF", "The current model's image capability is still loading. Please try adding the PDF again shortly."), "error");
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
        if (pdfJobsRef.current === 0) setPdfProgress(null);
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
    const files = clipboardFiles(event);
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

  // 发送（behavior 由 running 推导：运行中按用户选择的 steer/follow_up，否则 start）
  const submit = useCallback((): void => {
    setHistoryIndex(null);
    onSend(running ? queuedBehavior : "start");
  }, [onSend, running, queuedBehavior]);

  const selectableModels = models.filter((item) => providers.includes(item.provider));
  const selectedModel = selectableModels.find((item) => item.provider === session.provider && item.id === session.model) ?? currentModel;
  const supportedThinking = selectedModel?.capabilities.thinking ?? [];
  const declaredEfforts = selectedModel?.capabilities.effort ?? [];
  // 未声明（两数组均空）= 全部可选：滑块给全部六档，服务端同样放行合法枚举。
  const thinkingUndeclared = supportedThinking.length === 0 && declaredEfforts.length === 0;
  // 已声明档位按强度规范序重排（声明顺序可能乱序，滑块必须 默认→低→…→ultra 递增）
  const effortLevels = declaredEfforts.length > 0
    ? EFFORT_ALL.filter((tier) => (declaredEfforts as readonly string[]).includes(tier))
    : EFFORT_ALL;
  const hasActiveThinkingMode = supportedThinking.some((mode) => mode !== "disabled");
  const thinkingControlSupported = thinkingUndeclared || hasActiveThinkingMode || declaredEfforts.length > 0;
  const currentEffort = session.effort && effortLevels.includes(session.effort) ? session.effort : undefined;
  const thinkingOn = thinkingControlSupported && Boolean(
    (session.thinking && session.thinking !== "disabled" && (supportedThinking.length === 0 || supportedThinking.includes(session.thinking)))
    || currentEffort,
  );
  // 滑块左端点（默认）与开关 on 的无 effort 取值：优先 enabled，只声明 adaptive 时用 adaptive
  const defaultOnValue = supportedThinking.includes("adaptive") && !supportedThinking.includes("enabled") ? "mode:adaptive" : "mode:enabled";
  const thinkingBadge: [string, string] = !thinkingOn
    ? THINKING_LABEL.disabled!
    : currentEffort
      ? (EFFORT_LABEL[currentEffort] ?? [currentEffort, currentEffort])
      : THINKING_LABEL.enabled!;
  const selectionUnavailable = session.provider !== "" && !selectableModels.some((item) => item.provider === session.provider && item.id === session.model);

  /** 模型弹层选择：目标模型不支持当前 thinking/effort 时在同一请求中清除。 */
  const selectModel = (next: ModelProfile): void => {
    recordRecentModel(next.provider, next.id);
    const config: Record<string, unknown> = { provider: next.provider, model: next.id };
    if (session.thinking && next.capabilities.thinking.length > 0 && !next.capabilities.thinking.includes(session.thinking)) config.thinking = null;
    if (session.effort && next.capabilities.effort.length > 0 && !next.capabilities.effort.includes(session.effort)) config.effort = null;
    onConfig(config);
  };

  /** 思考弹层选择：value 形态 mode:<adaptive|enabled|disabled> / effort:<tier> / default。 */
  const selectThinking = (choice: string): void => {
    if (choice === "default" || choice === "mode:disabled") {
      onConfig({ thinking: null, effort: null });
      return;
    }
    if (choice.startsWith("mode:")) {
      onConfig({ thinking: choice.slice("mode:".length), effort: null });
      return;
    }
    const effort = choice.slice("effort:".length);
    const activeThinking = session.thinking !== "disabled" && session.thinking && supportedThinking.includes(session.thinking)
      ? session.thinking
      : supportedThinking.includes("enabled")
        ? "enabled"
        : supportedThinking.includes("adaptive")
          ? "adaptive"
          : null;
    onConfig({ thinking: activeThinking, effort });
  };

  // 会话模型实际变化（下拉选择/会话切换/配置生效）时，循环基准回到会话值；
  // 配置生效前的重渲染（如提示文本更新）不清空基准，保证连续 Ctrl+P 按列表顺序前进
  const propsModelRef = useRef({ provider: session.provider, model: session.model });
  if (propsModelRef.current.provider !== session.provider || propsModelRef.current.model !== session.model) {
    propsModelRef.current = { provider: session.provider, model: session.model };
    cycleBaseRef.current = null;
  }

  /** Ctrl+P 在最近使用的模型间循环（pi-agent 风格）。返回 false 表示不拦截按键（列表不足 2 条）。 */
  const cycleModel = (): boolean => {
    const base = cycleBaseRef.current ?? { provider: session.provider, model: session.model };
    const next = nextRecentModel(base);
    if (!next) return false;
    cycleBaseRef.current = next;
    const profile = selectableModels.find((item) => item.provider === next.provider && item.id === next.model);
    const config: Record<string, unknown> = { provider: next.provider, model: next.model };
    // 与下拉切换一致：目标模型不支持当前 thinking/effort 时在同一请求中清除
    if (profile) {
      if (session.thinking && profile.capabilities.thinking.length > 0 && !profile.capabilities.thinking.includes(session.thinking)) config.thinking = null;
      if (session.effort && profile.capabilities.effort.length > 0 && !profile.capabilities.effort.includes(session.effort)) config.effort = null;
    }
    onConfig(config);
    clearTimeout(modelCycleTimerRef.current);
    setModelCycleHint(t(`已切换模型：${next.model}【${next.provider}】`, `Switched model: ${next.model} (${next.provider})`));
    modelCycleTimerRef.current = setTimeout(() => setModelCycleHint(null), 2000);
    return true;
  };

  return (
    <footer className="composer" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
      <div className="composer-card">
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
      <AttachmentStrip attachments={attachments} onRemove={(index) => setAttachments((prev) => prev.filter((_, item) => item !== index))} />
      {editingMessage && (
        <div className="composer-editing-banner" role="status">
          <Icon name="edit" size={12} />
          <span className="composer-editing-text">
            {t("正在编辑早前消息", "Editing an earlier message")}
            {editingMessage.hadAttachments ? t("（原消息的附件不会重发，仅发送文本）", " (attachments from the original message will not be resent; text only)") : ""}
          </span>
          <button type="button" className="btn small" onClick={onCancelEdit}>
            {t("取消", "Cancel")}
          </button>
        </div>
      )}
      <div className="composer-input">
        {popupOpen && (
          <ul id="skill-listbox" className="composer-popup skill-popup" role="listbox" aria-label={t("技能建议", "Skill suggestions")}>
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
          <ul id="mention-listbox" className="composer-popup mention-popup" role="listbox" aria-label={t("文件引用建议", "File reference suggestions")}>
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
              onCancelEdit();
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
              // PDF 处理中忽略提交（按钮同时禁用）
              if (!processingPdf) submit();
            }
          }}
          placeholder={running
            ? t("向正在执行的作业补充指令…", "Add instructions to the running job…")
            : sendKey === "enter" ? t("描述要完成的编码任务…（Enter 发送，Shift+Enter 换行，@ 引用文件）", "Describe a coding task… (Enter to send, Shift+Enter for a new line, @ to reference files)") : t("描述要完成的编码任务…（Ctrl+Enter 发送，@ 引用文件）", "Describe a coding task… (Ctrl+Enter to send, @ to reference files)")}
        />
      </div>
      <MentionStrip paths={mentionedPaths} onRemove={removeMention} />
      {processingPdf && (
        <div className="composer-conversion" role="status" aria-live="polite">
          {pdfProgress?.stage === "converting"
            ? t(`正在将 PDF 转为图片（${pdfProgress.completed}/${pdfProgress.total}）…`, `Converting PDF to images (${pdfProgress.completed}/${pdfProgress.total})…`)
            : t(`正在保存 PDF${pdfProgress?.fileName ? `「${pdfProgress.fileName}」` : ""}到工作区…`, `Saving PDF${pdfProgress?.fileName ? ` “${pdfProgress.fileName}”` : ""} to the workspace…`)}
        </div>
      )}
      {pdfHintDismissed !== pdfHintSignature && (pdfToImageStatus !== "ready" ? (
        <div className="composer-hint">
          <span className="composer-hint-text">{t(
            pdfToImageStatus === "loading" ? "PDF 扩展状态加载中；图片可正常添加，PDF 请稍候重试。" : "PDF 扩展状态不可用；图片可正常添加，PDF 暂不能添加。",
            pdfToImageStatus === "loading" ? "PDF extension status is loading; images can still be added, but please retry PDFs shortly." : "PDF extension status is unavailable; images can still be added, but PDFs are unavailable for now.",
          )}</span>
          <button type="button" className="composer-hint-dismiss" aria-label={t("关闭提示", "Dismiss hint")} onClick={dismissPdfHint}><Icon name="x" size={12} /></button>
        </div>
      ) : pdfToImageEnabled ? (
        supportsImages && <div className="composer-hint">
          <span className="composer-hint-text">{t("支持添加、粘贴或拖拽图片/PDF（≤4 张图片，每张 ≤5MB）；PDF 会转为图片；输入 @ 引用工作区文件", "Add, paste, or drop images/PDFs (up to 4 images, 5 MB each); PDFs are converted to images; type @ to reference workspace files")}</span>
          <button type="button" className="composer-hint-dismiss" aria-label={t("关闭提示", "Dismiss hint")} onClick={dismissPdfHint}><Icon name="x" size={12} /></button>
        </div>
      ) : (
        <div className="composer-hint">
          <span className="composer-hint-text">{t("PDF 转图片扩展未启用；PDF 会先保存到工作区，再插入其路径引用。", "The PDF-to-image extension is disabled; PDFs are saved to the workspace and inserted as path references.")}</span>
          <button type="button" className="composer-hint-dismiss" aria-label={t("关闭提示", "Dismiss hint")} onClick={dismissPdfHint}><Icon name="x" size={12} /></button>
        </div>
      ))}
      {modelCycleHint && (
        <div className="composer-hint composer-model-cycle" role="status">{modelCycleHint}</div>
      )}
      <div className="composer-toolbar" aria-label={t("会话配置", "Session configuration")}>
        <button
          type="button"
          className="icon-btn composer-attach"
          disabled={processingPdf}
          aria-label={t("添加图片或 PDF", "Add image or PDF")}
          title={t("添加图片或 PDF", "Add image or PDF")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="paperclip" size={14} />
        </button>
        <span className="composer-permission">
          <PermissionModeMenu
            value={session.permissionMode ?? "ask"}
            disabled={running}
            onChange={(mode) => onConfig({ permissionMode: mode })}
          />
        </span>
        <AgentModeMenu
          agentMode={session.agentMode}
          swarmEnabled={session.swarmEnabled === true}
          disabled={running}
          onConfig={onConfig}
        />
        <span className="composer-toolbar-spacer" />
        {running && <span className="steering-hint">{t("运行中 · 发送将进入 Steering 队列", "Running · new messages enter the Steering queue")}</span>}
        {running && <span className="composer-running-dot" aria-hidden />}
        <span className="composer-menu-right">
          <ModelMenu
            current={{ provider: session.provider, model: session.model }}
            selectableModels={selectableModels}
            selectionUnavailable={selectionUnavailable}
            effortLevels={effortLevels}
            thinkingOn={thinkingOn}
            currentEffort={currentEffort}
            defaultOnValue={defaultOnValue}
            thinkingBadge={thinkingBadge}
            thinkingControlSupported={selectedModel === undefined || thinkingControlSupported}
            disabled={running}
            onSelectModel={selectModel}
            onSelectThinking={selectThinking}
            capabilities={selectedModel?.capabilities}
            onOpenModelSettings={() => ui.openSettings("models")}
          />
        </span>
        {running && (
          <span className="composer-menu-right">
            <span className="composer-menu">
              <button
                type="button"
                className="icon-btn queue-caret"
                aria-haspopup="menu"
                aria-expanded={queueMenuOpen}
                aria-label={t("运行中消息行为", "Message behavior while running")}
                title={queuedBehavior === "steer" ? t("本轮补充：立即插入正在运行的回合", "Steer: insert into the running turn right away") : t("完成后续跑：当前运行结束后再执行", "Follow-up: run after the current run finishes")}
                onClick={() => setQueueMenuOpen((value) => !value)}
              >
                <Icon name="chevron-up" size={12} />
              </button>
              <Popover open={queueMenuOpen} onClose={() => setQueueMenuOpen(false)}>
                {([
                  { value: "steer" as const, label: ["本轮补充", "Steer current run"] as [string, string], description: ["立即插入正在运行的回合", "Insert into the running turn right away"] as [string, string] },
                  { value: "follow_up" as const, label: ["完成后续跑", "Run after completion"] as [string, string], description: ["当前运行结束后自动执行", "Runs automatically once the current run finishes"] as [string, string] },
                ]).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={queuedBehavior === option.value}
                    className={`popover-item${queuedBehavior === option.value ? " selected" : ""}`}
                    onClick={() => { setQueuedBehavior(option.value); setQueueMenuOpen(false); }}
                  >
                    <span className="popover-item-check" aria-hidden>{queuedBehavior === option.value ? <Icon name="check" size={13} /> : null}</span>
                    <span className="popover-item-text">
                      <span className="popover-item-label">{t(...option.label)}</span>
                      <span className="popover-item-desc">{t(...option.description)}</span>
                    </span>
                  </button>
                ))}
              </Popover>
            </span>
          </span>
        )}
        <button
          className="composer-send"
          disabled={!draft.trim() || processingPdf}
          aria-label={editingMessage ? t("重发", "Resend") : draft.trimStart().startsWith("!") ? t("运行", "Run") : running ? queuedBehavior === "follow_up" ? t("完成后续跑", "Run after") : t("加入队列", "Queue") : t("发送", "Send")}
          title={processingPdf ? t("正在处理 PDF…", "Processing PDF…") : undefined}
          onClick={submit}
        >
          <Icon name="arrow-up" size={15} />
        </button>
      </div>
      </div>
    </footer>
  );
}
