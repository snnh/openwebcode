function activeLocale(): "zh-CN" | "en-US" {
  return typeof document !== "undefined" && document.documentElement.lang === "en" ? "en-US" : "zh-CN";
}

export function formatCurrency(microUnits: string, currency: string, locale = activeLocale()): string {
  // 服务端脏数据（空串/非数字）不应炸掉渲染，降级为占位符
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency === "CNY" ? "CNY" : "USD" })
      .format(Number(BigInt(microUnits)) / 1_000_000);
  } catch {
    return "-";
  }
}

export function formatTokens(value: number, locale = activeLocale()): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** 紧凑形式：12.4k / 1.2M */
export function formatTokensShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/** 微单位（1/1,000,000）转十进制字符串，用于表单回显 */
export function microToDecimal(microUnits: string): string {
  const value = Number(BigInt(microUnits)) / 1_000_000;
  return String(Number(value.toFixed(6)));
}

/** 时长：1.2s / 350ms（各面板统一精度） */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** 字节数：1.25 MiB / 512 KiB / 128 B */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
