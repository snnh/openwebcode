export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 工具参数校验失败时给模型的可自纠错提示：点名缺失/非法参数与期望形态，
 * 并列出实收键（异名参数如 command vs cmd 一目了然）。文案进 provider 历史，保持英文单行。
 */
export function invalidToolArgsMessage(name: string, input: Record<string, unknown>, expectation: string): string {
  const keys = Object.keys(input).join(", ") || "(none)";
  return `Invalid arguments for ${name}: ${expectation}. Received keys: ${keys}.`;
}
