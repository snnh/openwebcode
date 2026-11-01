/**
 * 内置 Agent 预设的英文显示名/描述（服务端内置预设的 name/description 是中文）。
 * 与 ExtensionsSection 的 OFFICIAL_EXTENSION_EN 同一做法：只在英文界面覆盖内置项，
 * 用户自定义预设按用户填写的原文显示。
 */
const PRESET_EN: Record<string, { name: string; description: string }> = {
  minimal: { name: "Minimal", description: "OWC's native trimmed prompt with an on-demand tool set." },
  "claude-code": { name: "Claude Code", description: "Mimics Claude Code's prompt style and tool naming." },
  "kimi-code": { name: "Kimi Code", description: "Mimics Kimi Code's prompt style and tool naming." },
  zcode: { name: "ZCode", description: "Mimics ZCode's prompt style and tool naming." },
  codex: { name: "Codex", description: "Mimics Codex's prompt style and tool naming." },
  "dsh-minimal": { name: "DSH Minimal", description: "Mimics DeepSeek Harness minimal mode." },
};

/** 按界面语言取预设显示名/描述（内置项在英文界面用本地化文案，自定义项原样返回）。 */
export function presetLabel(
  preset: { id: string; name: string; description: string },
  language: string,
): { name: string; description: string } {
  const english = language === "en" ? PRESET_EN[preset.id] : undefined;
  return english ?? { name: preset.name, description: preset.description };
}