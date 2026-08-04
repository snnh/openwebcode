import { useEffect, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import type { FileEntry, ManagedWorkspaceSyncChange, ManagedWorkspaceSyncPreview, SessionDetail } from "../../lib/contracts";
import { Icon } from "../Icon";
import { CodeBlock, Markdown } from "../Markdown";
import { useI18n } from "../../i18n";
import { EXT_LANGS } from "../../lib/file-langs";
import { formatBytes } from "../../lib/format";
import { useConfirmDialog } from "../ConfirmDialog";

const joinPath = (base: string, name: string): string => (base === "." ? name : `${base}/${name}`);

/** 图片预览扩展名白名单（阶段 2e）：命中时走 files/raw 二进制接口而非文本 content */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);
/** 加载更多步长（行），与 core 默认读取上限对齐 */
const LOAD_STEP = 2000;
/** 实际行数：末尾换行不算一行 */
const countLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if ((a.type === "directory") !== (b.type === "directory")) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function DirChildren({ sessionId, path, depth, selectedFile, onSelect }: {
  sessionId: string;
  path: string;
  depth: number;
  selectedFile?: string;
  onSelect(path: string): void;
}): ReactElement {
  const { t } = useI18n();
  const files = useQuery({ queryKey: ["files", sessionId, path], queryFn: () => api.listFiles(sessionId, path) });
  const indent = { paddingLeft: 10 + depth * 14 };
  if (files.isPending) return <p className="muted-empty tree-note" style={indent}>{t("加载中…", "Loading…")}</p>;
  if (files.isError) return (
    <p className="muted-empty tree-note" style={indent}>
      {t("无法读取目录", "Could not read directory")}
      {files.error instanceof ApiError ? `：${files.error.message}` : ""}
    </p>
  );
  if (files.data.entries.length === 0) return <p className="muted-empty tree-note" style={indent}>{t("（空目录）", "(Empty directory)")}</p>;
  return (
    <>
      {sortEntries(files.data.entries).map((entry) =>
        entry.type === "directory" ? (
          <TreeDir
            key={entry.name}
            sessionId={sessionId}
            path={joinPath(path, entry.name)}
            name={entry.name}
            depth={depth}
            selectedFile={selectedFile}
            onSelect={onSelect}
          />
        ) : (
          <button
            key={entry.name}
            className={`file-row${selectedFile === joinPath(path, entry.name) ? " active" : ""}`}
            style={indent}
            onClick={() => onSelect(joinPath(path, entry.name))}
            title={joinPath(path, entry.name)}
          >
            <span className="file-name">{entry.name}</span>
            <small>{formatBytes(entry.size)}</small>
          </button>
        ),
      )}
    </>
  );
}

function TreeDir({ sessionId, path, name, depth, selectedFile, onSelect }: {
  sessionId: string;
  path: string;
  name: string;
  depth: number;
  selectedFile?: string;
  onSelect(path: string): void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button
        className="file-row dir"
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="tree-arrow" aria-hidden><Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} /></span>
        <span className="file-name">{name}</span>
      </button>
      {expanded && (
        <DirChildren sessionId={sessionId} path={path} depth={depth + 1} selectedFile={selectedFile} onSelect={onSelect} />
      )}
    </>
  );
}

function actionLabel(action: ManagedWorkspaceSyncChange["action"], t: (zh: string, en: string) => string): string {
  switch (action) {
    case "create": return t("新增", "Create");
    case "update": return t("修改", "Update");
    case "delete": return t("删除", "Delete");
    case "conflict": return t("冲突", "Conflict");
    case "unsupported": return t("不支持", "Unsupported");
    default: return t("无变化", "Unchanged");
  }
}

function safeChangeCount(preview: ManagedWorkspaceSyncPreview): number {
  return preview.summary.create + preview.summary.update + preview.summary.delete;
}

export function FilesPanel({
  sessionId,
  session,
  running = false,
  onNotice,
  onOpenInEditor,
}: {
  sessionId?: string;
  session?: SessionDetail;
  running?: boolean;
  onNotice?(message: string, kind?: "info" | "error"): void;
  /** 阶段 2g：预览头部"在编辑器中打开"；未提供时保持只读预览 */
  onOpenInEditor?(file: string): void;
}): ReactElement {
  const { t } = useI18n();
  const [selectedFile, setSelectedFile] = useState<string>();
  const [syncPreview, setSyncPreview] = useState<ManagedWorkspaceSyncPreview>();
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncApplying, setSyncApplying] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [overwriteConflicts, setOverwriteConflicts] = useState(false);
  // 加载更多（阶段 2c）：已追加的分页内容与截断状态；切换文件/会话时重置
  const [appended, setAppended] = useState<{ content: string; truncated: boolean }>();
  const [loadingMore, setLoadingMore] = useState(false);
  // 图片加载失败回退（阶段 2e）
  const [imageError, setImageError] = useState(false);
  // Markdown 渲染/源码双态（阶段 2g）
  const [mdMode, setMdMode] = useState<"source" | "render">("source");
  useEffect(() => {
    setSelectedFile(undefined);
    setAppended(undefined);
    setLoadingMore(false);
    setImageError(false);
    setMdMode("source");
  }, [sessionId]);
  useEffect(() => {
    setAppended(undefined);
    setLoadingMore(false);
    setImageError(false);
    setMdMode("source");
  }, [selectedFile]);
  useEffect(() => {
    setSyncPreview(undefined);
    setSyncError(undefined);
    setSyncLoading(false);
    setSyncApplying(false);
    setOverwriteConflicts(false);
  }, [sessionId]);
  const ext = selectedFile?.split(".").pop()?.toLowerCase() ?? "";
  const isImage = Boolean(selectedFile) && IMAGE_EXTS.has(ext);
  const isMarkdown = ext === "md" || ext === "markdown";
  const preview = useQuery({
    queryKey: ["file", sessionId, selectedFile],
    queryFn: () => api.readFile(sessionId!, selectedFile!),
    enabled: Boolean(sessionId && selectedFile && !isImage),
  });

  if (!sessionId) {
    return <div className="inspector-body"><p className="muted-empty panel-empty">{t("选择会话以浏览工作区文件。", "Select a session to browse workspace files.")}</p></div>;
  }

  const managed = session?.workspace?.mode === "managed";
  const overlayfs = session?.workspace?.backend === "overlayfs";
  const previewLang = EXT_LANGS[ext];
  const visibleSyncChanges = syncPreview?.changes.filter((entry) => entry.action !== "none") ?? [];
  const safeChanges = syncPreview ? safeChangeCount(syncPreview) : 0;
  const conflictCount = syncPreview?.summary.conflicts ?? 0;
  const canApply = Boolean(syncPreview?.fingerprint) && !running && !syncApplying && (safeChanges > 0 || (overwriteConflicts && conflictCount > 0));

  // 加载更多（阶段 2c）：按已加载行数作 offset 续拉并追加渲染
  const previewContent = (preview.data?.content ?? "") + (appended?.content ?? "");
  const previewTruncated = appended ? appended.truncated : (preview.data?.truncated ?? false);
  const loadMore = (): void => {
    if (!sessionId || !selectedFile || !preview.data || loadingMore) return;
    setLoadingMore(true);
    api.readFile(sessionId, selectedFile, { offset: countLines(previewContent), limit: LOAD_STEP })
      .then((result) => setAppended({ content: (appended?.content ?? "") + result.content, truncated: result.truncated }))
      .catch((error: unknown) => {
        onNotice?.(error instanceof Error ? error.message : t("加载更多内容失败", "Failed to load more content"), "error");
      })
      .finally(() => setLoadingMore(false));
  };

  const generateSyncPreview = (): void => {
    setSyncLoading(true);
    setSyncError(undefined);
    setOverwriteConflicts(false);
    api.workspaceSyncPreview(sessionId)
      .then((result) => setSyncPreview(result))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : t("无法生成同步差异", "Could not generate the sync diff");
        setSyncError(message);
        onNotice?.(message, "error");
      })
      .finally(() => setSyncLoading(false));
  };

  const confirm = useConfirmDialog();

  const runApplySync = (fingerprint: string): void => {
    setSyncApplying(true);
    setSyncError(undefined);
    api.syncWorkspace(sessionId, { confirm: true, previewFingerprint: fingerprint, ...(overwriteConflicts ? { overwriteConflicts: true } : {}) })
      .then((result) => {
        setSyncPreview(result.nextPreview);
        setOverwriteConflicts(false);
        const message = result.applied.length
          ? t(`已回写 ${result.applied.length} 项${result.conflicts.length ? `；仍有 ${result.conflicts.length} 项冲突` : ""}`, `Wrote back ${result.applied.length} item(s)${result.conflicts.length ? `; ${result.conflicts.length} conflict(s) remain` : ""}`)
          : t("没有可安全回写的改动", "No changes could be safely written back");
        onNotice?.(message, result.applied.length ? "info" : "error");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : t("回写源目录失败", "Could not write back to the source directory");
        setSyncError(message);
        onNotice?.(message, "error");
      })
      .finally(() => setSyncApplying(false));
  };

  const applySync = (): void => {
    const fingerprint = syncPreview?.fingerprint;
    if (!fingerprint || !canApply) return;
    if (overwriteConflicts && conflictCount > 0) {
      confirm.ask({
        title: t("覆盖冲突", "Overwrite conflicts"),
        body: t(
          `将覆盖源目录中 ${conflictCount} 个冲突项。请确认已核对预览。`,
          `This overwrites ${conflictCount} conflicting source item(s). Confirm that you reviewed the preview.`,
        ),
        confirmLabel: t("确认覆盖", "Confirm overwrite"),
        danger: false,
        onConfirm: () => runApplySync(fingerprint),
      });
      return;
    }
    runApplySync(fingerprint);
  };

  return (
    <div className="files-panel-wrap">
      <div className="inspector-body files-panel">
        <div className="panel-head">
          <h2>{t("文件", "Files")}</h2>
          {managed && (
            <button
              className="btn small"
              disabled={syncLoading}
              onClick={generateSyncPreview}
              title={t("生成镜像盘与源目录的差异；不会自动写回", "Generate a disk-image/source diff; nothing is written automatically")}
            >
              <Icon name="upload" size={12} /> {syncLoading ? t("正在比较…", "Comparing…") : t("同步回源", "Sync back")}
            </button>
          )}
        </div>
        {managed && syncError && <p className="workspace-sync-error" role="alert">{syncError}</p>}
        {managed && syncPreview && (
          <section className="workspace-sync-preview" aria-label={t("同步回源预览", "Sync-back preview")}>
            <div className="workspace-sync-head">
              <div>
                <h3>{t("同步回源预览", "Sync-back preview")}</h3>
                <p>{t("仅在确认后写入源目录；关闭或删除会话不会自动回写。", "The source directory is changed only after confirmation; closing or deleting the session never writes back automatically.")}</p>
              </div>
              <button className="icon-btn" onClick={() => setSyncPreview(undefined)} aria-label={t("关闭同步预览", "Close sync preview")}><Icon name="x" size={14} /></button>
            </div>
            <p className="workspace-sync-origin" title={session?.workspace?.originCwd}>{t("源目录：", "Source: ")}{session?.workspace?.originCwd}</p>
            {!syncPreview.baseline.available && (
              <p className="workspace-sync-warning">
                {t("此旧会话没有初始基线：所有差异均视为冲突，默认不会写回。若要继续，必须明确选择覆盖冲突项。", "This older session has no initial baseline: every difference is treated as a conflict and is not written by default. Continuing requires an explicit overwrite choice.")}
              </p>
            )}
            <div className="workspace-sync-summary">
              <span>{t(`新增 ${syncPreview.summary.create}`, `Create ${syncPreview.summary.create}`)}</span>
              <span>{t(`修改 ${syncPreview.summary.update}`, `Update ${syncPreview.summary.update}`)}</span>
              <span>{t(`删除 ${syncPreview.summary.delete}`, `Delete ${syncPreview.summary.delete}`)}</span>
              <span className={conflictCount ? "danger" : undefined}>{t(`冲突 ${conflictCount}`, `Conflicts ${conflictCount}`)}</span>
              {syncPreview.summary.unsupported > 0 && <span className="warning">{t(`不支持 ${syncPreview.summary.unsupported}`, `Unsupported ${syncPreview.summary.unsupported}`)}</span>}
            </div>
            {visibleSyncChanges.length === 0 ? (
              <p className="muted-empty panel-empty">{overlayfs
                ? t("merged 视图与源目录没有需要同步的差异。", "The merged view and the source directory have no changes to sync.")
                : t("镜像盘与源目录没有需要同步的差异。", "The disk image and source directory have no changes to sync.")}</p>
            ) : (
              <ul className="workspace-sync-list">
                {visibleSyncChanges.slice(0, 200).map((entry) => (
                  <li key={`${entry.action}:${entry.path}`} className={`workspace-sync-${entry.action}`} title={entry.reason}>
                    <span className="workspace-sync-action">{actionLabel(entry.action, t)}</span>
                    <code>{entry.path || "."}</code>
                  </li>
                ))}
              </ul>
            )}
            {visibleSyncChanges.length > 200 && <p className="muted-empty panel-empty">{t(`仅显示前 200 项，共 ${visibleSyncChanges.length} 项。`, `Showing the first 200 of ${visibleSyncChanges.length} items.`)}</p>}
            {conflictCount > 0 && (
              <label className="workspace-sync-force">
                <input type="checkbox" checked={overwriteConflicts} onChange={(event) => setOverwriteConflicts(event.target.checked)} />
                {overlayfs
                  ? t("覆盖源目录冲突项（含无基线旧会话；将以 merged 视图内容为准）", "Overwrite conflicting source items (including older sessions without a baseline; use merged-view contents)")
                  : t("覆盖源目录冲突项（含无基线旧会话；将以镜像盘内容为准）", "Overwrite conflicting source items (including older sessions without a baseline; use disk-image contents)")}
              </label>
            )}
            <div className="dialog-actions workspace-sync-actions">
              <button className="btn small" onClick={generateSyncPreview} disabled={syncLoading || syncApplying}>{t("刷新差异", "Refresh diff")}</button>
              <button
                className="btn small primary"
                onClick={applySync}
                disabled={!canApply}
                title={running ? t("运行中的 agent 可能正在写文件；停止后再回写", "The running agent may be writing files; stop it before writing back") : undefined}
              >
                <Icon name="check" size={12} /> {syncApplying ? t("正在回写…", "Writing back…") : overwriteConflicts && conflictCount ? t("确认并覆盖回写", "Confirm and overwrite") : t(`确认回写 ${safeChanges} 项`, `Confirm ${safeChanges} item(s)`) }
              </button>
            </div>
          </section>
        )}
        <div className="file-tree">
          <DirChildren sessionId={sessionId} path="." depth={0} selectedFile={selectedFile} onSelect={setSelectedFile} />
        </div>
      </div>
      {selectedFile && (
        <section className="file-preview" aria-label={t(`预览 ${selectedFile}`, `Preview ${selectedFile}`)}>
          <header>
            <span className="mono" title={selectedFile}>{selectedFile}</span>
            {isMarkdown && !isImage && (
              <span className="md-toggle" role="group" aria-label={t("Markdown 预览模式", "Markdown preview mode")}>
                <button
                  className={`btn small${mdMode === "render" ? " primary" : ""}`}
                  aria-pressed={mdMode === "render"}
                  onClick={() => setMdMode("render")}
                >
                  {t("渲染", "Rendered")}
                </button>
                <button
                  className={`btn small${mdMode === "source" ? " primary" : ""}`}
                  aria-pressed={mdMode === "source"}
                  onClick={() => setMdMode("source")}
                >
                  {t("源码", "Source")}
                </button>
              </span>
            )}
            {onOpenInEditor && (
              <button
                className="btn small"
                onClick={() => onOpenInEditor(selectedFile)}
                aria-label={t(`在编辑器中打开 ${selectedFile}`, `Open ${selectedFile} in editor`)}
              >
                <Icon name="edit" size={12} />
                {t("在编辑器中打开", "Open in editor")}
              </button>
            )}
            <button className="icon-btn" onClick={() => setSelectedFile(undefined)} aria-label={t("关闭预览", "Close preview")}><Icon name="x" size={14} /></button>
          </header>
          {isImage ? (
            imageError ? (
              <p className="muted-empty preview-note">{t("无法预览该图片。", "Could not preview this image.")}</p>
            ) : (
              <img
                className="file-preview-img"
                loading="lazy"
                src={api.fileRawUrl(sessionId, selectedFile)}
                alt={selectedFile}
                onError={() => setImageError(true)}
              />
            )
          ) : preview.isError ? (
            <p className="muted-empty preview-note">
              {preview.error instanceof ApiError && /UTF-8/i.test(preview.error.message)
                ? t("该文件非 UTF-8 文本（可能为二进制），无法预览。", "This file is not UTF-8 text (it may be binary) and cannot be previewed.")
                : preview.error instanceof ApiError
                  ? preview.error.message
                  : t("无法读取该文件。", "Could not read this file.")}
            </p>
          ) : preview.data ? (
            <>
              {isMarkdown && mdMode === "render" ? (
                <Markdown>{previewContent}</Markdown>
              ) : (
                <CodeBlock lang={previewLang} code={previewContent} />
              )}
              {previewTruncated ? (
                <p className="muted-empty preview-note">
                  {t("内容过长，已截断。", "Content was truncated because it is too long.")}
                  <button className="btn small" disabled={loadingMore} onClick={loadMore}>
                    {loadingMore ? t("加载中…", "Loading…") : t("加载更多", "Load more")}
                  </button>
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted-empty preview-note">{t("加载中…", "Loading…")}</p>
          )}
        </section>
      )}
      {confirm.dialogElement}
    </div>
  );
}
