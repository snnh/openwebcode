/**
 * 扩展配置的松散 JSON Schema 子集校验（type/properties/required/enum + additionalProperties: false）。
 * 只校验顶层一层，不做 default 填充与嵌套递归；返回可读错误消息，null 表示通过。
 */
export function validateConfigAgainstSchema(schema: Record<string, unknown>, config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "config must be an object";
  const values = config as Record<string, unknown>;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const additional = schema.additionalProperties !== false;
  for (const key of Object.keys(values)) {
    if (!(key in properties)) {
      if (!additional) return `Unknown config key "${key}"`;
      continue;
    }
    const problem = validateValue(key, values[key], properties[key]);
    if (problem) return problem;
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  for (const key of required) {
    if (!(key in values) || values[key] === undefined) return `Missing required config key "${key}"`;
  }
  return null;
}

function validateValue(key: string, value: unknown, definition: unknown): string | null {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return null;
  const spec = definition as Record<string, unknown>;
  if (typeof spec.type === "string" && !matchesType(spec.type, value)) {
    return `Config key "${key}" must be of type ${spec.type}`;
  }
  // enum 只对字符串成员做松散校验（表单枚举的常规用法）
  if (Array.isArray(spec.enum) && typeof value === "string" && spec.enum.every((item) => typeof item === "string") && !spec.enum.includes(value)) {
    return `Config key "${key}" must be one of: ${spec.enum.join(", ")}`;
  }
  return null;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}
