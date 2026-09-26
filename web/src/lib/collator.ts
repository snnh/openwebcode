/**
 * 文本排序的统一口径：固定中文 locale（拼音）+ 数字感知 + 忽略大小写，
 * 避免「不同机器的默认 locale 不同 → 分组名/文件名/标签顺序不同」的不确定性
 * （CI 的 C locale 与中文环境的 localeCompare 结果相反，曾让测试在 CI 挂掉）。
 */
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}
