import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useI18n } from "../i18n";

interface BrowseEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
}

interface DirectoryBrowserProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/**
 * 浮层目录浏览器：面包屑 + 列表（目录可进入、文件灰显、符号链接不跟随）。
 * 可遍历范围由 server browseRoots 限制；越界路径返回 403。
 */
export function DirectoryBrowser({ initialPath, onSelect, onClose }: DirectoryBrowserProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  // 可用浏览根
  const rootsQuery = useQuery({ queryKey: ["browse-roots"], queryFn: api.browseRoots });
  const roots = useMemo(() => rootsQuery.data?.roots ?? [], [rootsQuery.data?.roots]);

  // 当前路径：优先 initialPath，否则第一个浏览根
  const [currentPath, setCurrentPath] = useState(initialPath ?? "");
  useEffect(() => {
    if (!currentPath && roots.length > 0) setCurrentPath(roots[0]);
  }, [roots, currentPath]);

  // 打开浮层
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // 列出当前目录内容
  const dirQuery = useQuery({
    queryKey: ["browse-dir", currentPath],
    queryFn: () => api.browseDirectory(currentPath),
    enabled: !!currentPath,
  });

  // 面包屑段：将 currentPath 拆分为可点击的层级
  const breadcrumb = (() => {
    if (!currentPath) return [] as { label: string; path: string }[];
    const sep = currentPath.includes("/") ? "/" : "\\";
    const parts = currentPath.split(sep).filter(Boolean);
    const segments: { label: string; path: string }[] = [];
    // Windows 盘符根（如 C:）
    if (currentPath.match(/^[A-Za-z]:[\\/]/)) {
      const drive = parts[0];
      segments.push({ label: drive, path: drive + sep });
      for (let i = 1; i < parts.length; i++) {
        segments.push({ label: parts[i], path: segments[i - 1].path + parts[i] + (i < parts.length - 1 ? sep : "") });
      }
    } else {
      // POSIX 根 /
      segments.push({ label: "/", path: "/" });
      let acc = "";
      for (const part of parts) {
        acc += (acc === "/" ? "" : "/") + part;
        segments.push({ label: part, path: acc });
      }
    }
    return segments;
  })();

  const entries = dirQuery.data?.entries ?? [];
  const parent = dirQuery.data?.parent ?? null;

  function handleEntryClick(entry: BrowseEntry) {
    if (!entry.isDir || entry.isSymlink) return;
    const sep = currentPath.includes("/") ? "/" : "\\";
    const next = currentPath.endsWith(sep) ? currentPath + entry.name : currentPath + sep + entry.name;
    setCurrentPath(next);
  }

  return (
    <dialog ref={dialogRef} className="dir-browser" onClose={onClose}>
      <div className="dir-browser__header">
        <select
          className="input dir-browser__root-select"
          value={roots.includes(currentPath) ? currentPath : ""}
          onChange={(e) => e.target.value && setCurrentPath(e.target.value)}
        >
          {roots.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <nav className="dir-browser__breadcrumb">
          {breadcrumb.map((seg, i) => (
            <span key={seg.path} className="dir-browser__crumb">
              {i > 0 && <span className="dir-browser__sep">/</span>}
              <button type="button" className="dir-browser__crumb-btn" onClick={() => setCurrentPath(seg.path)}>
                {seg.label}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="dir-browser__body">
        {dirQuery.isLoading && <div className="dir-browser__hint">{t("加载中…", "Loading…")}</div>}
        {dirQuery.isError && (
          <div className="dir-browser__hint dir-browser__hint--error">
            {t("无法读取此目录", "Cannot read this directory")}
            {parent && (
              <button type="button" className="btn" onClick={() => setCurrentPath(parent)}>
                {t("返回上级", "Go back")}
              </button>
            )}
          </div>
        )}
        {!dirQuery.isLoading && !dirQuery.isError && entries.length === 0 && (
          <div className="dir-browser__hint">{t("此目录为空", "This directory is empty")}</div>
        )}
        {!dirQuery.isLoading && !dirQuery.isError && entries.length > 0 && (
          <ul className="dir-browser__list">
            {parent && (
              <li>
                <button type="button" className="dir-browser__entry dir-browser__entry--parent" onClick={() => setCurrentPath(parent)}>
                  <span className="dir-browser__icon">↑</span>
                  <span className="dir-browser__name">..</span>
                </button>
              </li>
            )}
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={`dir-browser__entry${entry.isDir ? "" : " dir-browser__entry--file"}${entry.isSymlink ? " dir-browser__entry--symlink" : ""}`}
                  disabled={!entry.isDir || entry.isSymlink}
                  onClick={() => handleEntryClick(entry)}
                >
                  <span className="dir-browser__icon">{entry.isDir ? "📁" : entry.isSymlink ? "🔗" : "📄"}</span>
                  <span className="dir-browser__name">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="dir-browser__footer">
        <span className="dir-browser__current-path" title={currentPath}>{currentPath}</span>
        <div className="dir-browser__actions">
          <button type="button" className="btn" onClick={onClose}>{t("取消", "Cancel")}</button>
          <button type="button" className="btn btn--primary" onClick={() => onSelect(currentPath)} disabled={!currentPath}>
            {t("选择此目录", "Select this directory")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
