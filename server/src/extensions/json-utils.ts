/** 把 unknown 收窄为普通对象记录；数组 / null / 非对象返回 undefined。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 毫秒时间戳 → ISO 字符串；非法 / 缺失返回 undefined。 */
export function isoOfMs(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}
