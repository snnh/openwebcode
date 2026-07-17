import { useEffect, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import type { FileEntry } from "../../lib/contracts";
import { Icon } from "../Icon";
import { CodeBlock } from "../Markdown";

const joinPath = (base: string, name: string): string => (base === "." ? name : `${base}/${name}`);

const EXT_LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", html: "html", htm: "html", md: "markdown", markdown: "markdown",
  py: "python", sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", diff: "diff", patch: "diff",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
  const files = useQuery({ queryKey: ["files", sessionId, path], queryFn: () => api.listFiles(sessionId, path) });
  const indent = { paddingLeft: 10 + depth * 14 };
  if (files.isPending) return <p className="tree-note" style={indent}>加载中…</p>;
  if (files.isError) return <p className="tree-note" style={indent}>无法读取目录</p>;
  if (files.data.entries.length === 0) return <p className="tree-note" style={indent}>（空目录）</p>;
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
            <small>{formatSize(entry.size)}</small>
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

export function FilesPanel({ sessionId }: { sessionId?: string }): ReactElement {
  const [selectedFile, setSelectedFile] = useState<string>();
  useEffect(() => setSelectedFile(undefined), [sessionId]);
  const preview = useQuery({
    queryKey: ["file", sessionId, selectedFile],
    queryFn: () => api.readFile(sessionId!, selectedFile!),
    enabled: Boolean(sessionId && selectedFile),
  });

  if (!sessionId) {
    return <div className="inspector-body"><p className="panel-empty">选择会话以浏览工作区文件。</p></div>;
  }

  const ext = selectedFile?.split(".").pop()?.toLowerCase() ?? "";
  const previewLang = EXT_LANGS[ext];

  return (
    <div className="inspector-body files-panel">
      <div className="file-tree">
        <DirChildren sessionId={sessionId} path="." depth={0} selectedFile={selectedFile} onSelect={setSelectedFile} />
      </div>
      {selectedFile && (
        <section className="file-preview" aria-label={`预览 ${selectedFile}`}>
          <header>
            <span className="mono" title={selectedFile}>{selectedFile}</span>
            <button className="icon-btn" onClick={() => setSelectedFile(undefined)} aria-label="关闭预览"><Icon name="x" size={14} /></button>
          </header>
          {preview.isError ? (
            <p className="preview-note">
              {preview.error instanceof ApiError && /UTF-8/i.test(preview.error.message)
                ? "该文件非 UTF-8 文本（可能为二进制），无法预览。"
                : preview.error instanceof ApiError
                  ? preview.error.message
                  : "无法读取该文件。"}
            </p>
          ) : preview.data ? (
            <>
              <CodeBlock lang={previewLang} code={preview.data.content} />
              {preview.data.truncated && <p className="preview-note">内容过长，已截断。</p>}
            </>
          ) : (
            <p className="preview-note">加载中…</p>
          )}
        </section>
      )}
    </div>
  );
}
