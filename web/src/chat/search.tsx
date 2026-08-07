/**
 * 会话内搜索（Ctrl+F）：搜索条 + 命中计算 + DOM 级 <mark> 高亮。
 * 高亮不动 React 渲染：由 MessageList 的 layout effect 走文本节点包 <mark class="conv-search-hit">，
 * 依赖变化/卸载时 unwrap 还原（MessageCard 已 memo，搜索期间正文几乎不重渲染）。
 */
import { useEffect, useRef, type ReactElement } from "react";
import type { ChatMessage } from "../lib/contracts";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import type { SearchBarProps } from "./types";

export interface SearchMatch {
  messageId: string;
  /** 该消息内的第几次出现（0 起，按文档序） */
  occurrence: number;
}

/** 大小写不敏感子串匹配：仅 user/assistant 消息的 text 内容块（工具结果等排除，避免噪音） */
export function findMatches(messages: ChatMessage[], query: string): SearchMatch[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const result: SearchMatch[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .toLowerCase();
    let from = 0;
    let occurrence = 0;
    for (;;) {
      const found = text.indexOf(needle, from);
      if (found === -1) break;
      result.push({ messageId: message.id, occurrence });
      occurrence += 1;
      from = found + needle.length;
    }
  }
  return result;
}

/** 移除 root 内全部搜索高亮 <mark>，并 normalize 还原被拆分的文本节点 */
export function unwrapSearchMarks(root: ParentNode): void {
  for (const mark of Array.from(root.querySelectorAll("mark.conv-search-hit"))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  root.normalize();
}

/**
 * 在单篇文章内包裹全部命中为 <mark class="conv-search-hit">；
 * activeOccurrence ≥ 0 时该次出现追加 .active。
 * 只走文章直属的文本块容器（:scope > .markdown），与 findMatches 的口径
 * （仅 user/assistant 的 text 内容块）对齐：思考、工具卡、meta 行不参与。
 */
export function highlightArticle(article: Element, query: string, activeOccurrence: number): void {
  const needle = query.toLowerCase();
  if (!needle) return;
  const doc = article.ownerDocument;
  const containers = article.querySelectorAll(":scope > .markdown");
  const nodes: Text[] = [];
  for (const container of Array.from(containers)) {
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.parentElement?.closest("mark.conv-search-hit")) continue;
      nodes.push(node);
    }
  }
  let occurrence = 0;
  for (const node of nodes) {
    let rest: Text = node;
    let offset = rest.data.toLowerCase().indexOf(needle);
    while (offset !== -1) {
      const hit = rest.splitText(offset);
      rest = hit.splitText(needle.length);
      const mark = doc.createElement("mark");
      mark.className = occurrence === activeOccurrence ? "conv-search-hit active" : "conv-search-hit";
      mark.appendChild(doc.createTextNode(hit.data));
      hit.parentNode?.replaceChild(mark, hit);
      occurrence += 1;
      offset = rest.data.toLowerCase().indexOf(needle);
    }
  }
}

/** 会话内搜索条：匹配数据驱动；高亮与滚动定位由 MessageList 布局效果统一施加 */
export function ConversationSearchBar({ query, onQueryChange, current, total, onNext, onPrev, onClose, loadedOnly, focusSignal = 0 }: SearchBarProps): ReactElement {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusSignal]);

  return (
    <div className="conversation-search" role="search">
      <Icon name="search" size={13} />
      <input
        ref={inputRef}
        className="conversation-search-input"
        type="text"
        value={query}
        placeholder={t("在对话中搜索", "Find in conversation")}
        aria-label={t("在对话中搜索", "Find in conversation")}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) onPrev();
            else onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      {query && (
        <span className="conversation-search-count" aria-live="polite">
          {total > 0 ? `${current + 1}/${total}` : t("无结果", "No results")}
        </span>
      )}
      {loadedOnly && (
        <span className="conversation-search-hint" title={t("上方还有未加载的历史消息", "Older messages above are not loaded")}>
          {t("仅搜索已加载消息", "Loaded messages only")}
        </span>
      )}
      <button className="conversation-search-btn" aria-label={t("上一个", "Previous match")} disabled={total === 0} onClick={onPrev}>
        <Icon name="chevron-up" size={13} />
      </button>
      <button className="conversation-search-btn" aria-label={t("下一个", "Next match")} disabled={total === 0} onClick={onNext}>
        <Icon name="chevron-down" size={13} />
      </button>
      <button className="conversation-search-btn" aria-label={t("关闭", "Close")} onClick={onClose}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
