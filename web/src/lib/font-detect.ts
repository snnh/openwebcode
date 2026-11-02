export function firstFamily(stack: string): string {
  return stack.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/** 字体可用性检测结果缓存（canvas 测量较贵，设置页一次渲染内复用）。 */
const cache = new Map<string, boolean>();

export function fontAvailable(family: string): boolean {
  if (!family) return false;
  const cached = cache.get(family);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (context) {
      const sample = "mmmmmmmmmmlliWWQ@#";
      available = ["monospace", "sans-serif", "serif"].some((base) => {
        context.font = `72px ${base}`;
        const baseWidth = context.measureText(sample).width;
        context.font = `72px "${family}", ${base}`;
        return Math.abs(context.measureText(sample).width - baseWidth) > 0.01;
      });
    }
  } catch {
    available = false;
  }
  cache.set(family, available);
  return available;
}
