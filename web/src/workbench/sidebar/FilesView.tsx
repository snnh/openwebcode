/**
 * 侧栏文件视图：目录树（目录优先排序、懒展开）、点击预览（文本/图片/Markdown 双态）、
 * 长文件「加载更多」分页、「在编辑器中打开」跳编辑器分栏（auxViews.openEditor）。
 * 数据经 api.listFiles/readFile（react-query）；无会话时按空态提示。
 */
import { useEffect, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import type { FileEntry } from "../../lib/contracts";
import { Icon } from "../../components/Icon";
import { CodeBlock, Markdown } from "../../components/Markdown";
import { useI18n } from "../../i18n";
import { EXT_LANGS } from "../../lib/file-langs";
import { formatBytes } from "../../lib/format";
import { auxViews } from "../aux-views";

const joinPath = (base: string, name: string): string => (base === "." ? name : `${base}/${name}`);

/** 图片预览扩展名白名单：命中时走 files/raw 二进制接口而非文本 content */
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
  selectedFile?: string | undefined;
  onSelect(path: string): void;
}): ReactElement {
  const { t } = useI18n();
  const files = useQuery({ queryKey: ["files", sessionId, path], queryFn: () => api.listFiles(sessionId, path) });
  const indent = { paddingLeft: 10 + depth * 14 };
  if (files.isPending) return <p className="muted-empty tree-note" style={indent}>{t("加载中…", "Loading…")}</p>;
  if (files.isError) return (
    <p className="panel-error tree-note" role="alert" style={indent}>
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
  selectedFile?: string | undefined;
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

export function FilesView({ sessionId }: { sessionId?: string | undefined }): ReactElement {
  const { t } = useI18n();
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  // 加载更多：已追加的分页内容与截断状态；切换文件/会话时重置
  const [appended, setAppended] = useState<{ content: string; truncated: boolean } | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | undefined>();
  // 图片加载失败回退
  const [imageError, setImageError] = useState(false);
  // Markdown 渲染/源码双态
  const [mdMode, setMdMode] = useState<"source" | "render">("source");
  useEffect(() => {
    setSelectedFile(undefined);
    setAppended(undefined);
    setLoadingMore(false);
    setMoreError(undefined);
    setImageError(false);
    setMdMode("source");
  }, [sessionId]);
  useEffect(() => {
    setAppended(undefined);
    setLoadingMore(false);
    setMoreError(undefined);
    setImageError(false);
    setMdMode("source");
  }, [selectedFile]);

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

  const previewLang = EXT_LANGS[ext];

  // 加载更多：按已加载行数作 offset 续拉并追加渲染
  const previewContent = (preview.data?.content ?? "") + (appended?.content ?? "");
  const previewTruncated = appended ? appended.truncated : (preview.data?.truncated ?? false);
  const loadMore = (): void => {
    if (!selectedFile || !preview.data || loadingMore) return;
    setLoadingMore(true);
    api.readFile(sessionId, selectedFile, { offset: countLines(previewContent), limit: LOAD_STEP })
      .then((result) => setAppended({ content: (appended?.content ?? "") + result.content, truncated: result.truncated }))
      .catch((error: unknown) => setMoreError(error instanceof Error ? error.message : t("加载更多内容失败", "Failed to load more content")))
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="files-panel-wrap">
      <div className="inspector-body">
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
            <button
              className="btn small"
              onClick={() => auxViews.openEditor(selectedFile)}
              aria-label={t(`在编辑器中打开 ${selectedFile}`, `Open ${selectedFile} in editor`)}
            >
              <Icon name="edit" size={12} />
              {t("在编辑器中打开", "Open in editor")}
            </button>
            <button className="icon-btn" onClick={() => setSelectedFile(undefined)} aria-label={t("关闭预览", "Close preview")}><Icon name="x" size={14} /></button>
          </header>
          {isImage ? (
            imageError ? (
              <p className="panel-error" role="alert">{t("无法预览该图片。", "Could not preview this image.")}</p>
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
            <p className="panel-error" role="alert">
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
              {moreError && <p className="panel-error" role="alert">{moreError}</p>}
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
    </div>
  );
}
