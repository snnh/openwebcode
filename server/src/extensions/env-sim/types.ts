/** env-sim 预设：身份行 + 基线提示词 + 产品小节 + 工具形态（隐藏/别名）。 */
export interface PersonaAlias {
  from: string;
  as: string;
  description?: string;
}

export interface PersonaPreset {
  id: string;
  name: string;
  identity: string;
  basePrompt: string;
  productSections: string[];
  hideBuiltIns: string[];
  aliases: PersonaAlias[];
}

export interface PersonaSummary {
  id: string;
  name: string;
  builtin: boolean;
}
