export type ExtensionPermission = "context:read" | "context:mutate" | "tools:register" | "sessions:read" | "ui:panel" | "ui:messageAttachment" | "network:fetch";

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  apiVersion: string;
  permissions: ExtensionPermission[];
  official?: boolean;
  defaultEnabled?: boolean;
  enabled: boolean;
  builtIn: boolean;
  status: "running" | "disabled" | "error";
  config: Record<string, unknown>;
  /** JSON Schema 子集（object + string/number/integer/boolean 属性、enum、一层嵌套组、字符串字典）；存在时设置界面渲染类型化表单 */
  configSchema?: Record<string, unknown>;
  /** 可选人格预设清单（目前仅 env-sim 提供） */
  availablePersonas?: Array<{ id: string; name: string; builtin: boolean }>;
  error?: string;
}
