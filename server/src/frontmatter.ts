/**
 * Parse optional YAML-like frontmatter (--- delimited) from markdown text.
 * Returns { meta, body } where meta maps lowercased keys to trimmed string
 * values, and body is the content after the frontmatter (or the full text
 * if no frontmatter block is present).
 *
 * List items (`- value` under a key with an empty value) are collected into
 * the corresponding entry in `listMeta`.
 */
export function parseFrontmatter(text: string): {
  meta: Record<string, string>;
  listMeta: Record<string, string[]>;
  body: string;
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, listMeta: {}, body: text };
  const meta: Record<string, string> = {};
  const listMeta: Record<string, string[]> = {};
  let listKey: string | undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item && listKey) {
      listMeta[listKey]!.push(item[1]!.replace(/^['"]|['"]$/g, ""));
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) {
      listKey = undefined;
      continue;
    }
    const key = kv[1]!.toLowerCase();
    meta[key] = kv[2]!.trim();
    listKey = meta[key] === "" ? key : undefined;
    if (listKey) listMeta[listKey] = [];
  }
  return { meta, listMeta, body: match[2]! };
}
