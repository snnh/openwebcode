/**
 * dsh 兼容层 · dsh-tools 垫片（M1）
 *
 * 对 `@deepseek-ai/dsh-tools`（上游 packages/core/tools）的 `defineTool` 子集复刻：
 * - 参数 DSL（隐式对象根 + 每属性 `required: true` 注记）编译为 JSON Schema，作者侧
 *   未知键 fail loud（对齐上游 compilePropertyMap 的 author 键断言）；
 * - `execute(args, exec)` 前做参数校验，违规抛 `ToolArgsError`（isError 语义由宿主落）；
 * - `presentCall`/`presentResult`/`isConcurrencySafe` 软校验：参数失配时分别回退
 *   undefined/undefined/false，绝不抛错（上游展示层回放安全约束）；
 * - `output.render(args, value)` 产出文本/结构块，M3 宿主将其映射到 owc 工具结果。
 */
/** lossless JSON 值（垫片内部用；跨进程序列化由宿主保证）。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 渲染块：文本块为主，其余结构块原样透传给宿主映射。 */
export interface ToolRenderBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** 参数/输出 schema 的作者侧 DSL（上游 ValueSchemaSpec 子集）。 */
export interface ValueSchemaAnnotations {
  description?: string;
  title?: string;
  /** 非校验性注记；必须是 lossless JSON 数据。 */
  default?: JsonValue;
  examples?: JsonValue;
}

export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: "string";
  enum?: readonly string[];
  const?: string;
}

export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: "number";
  enum?: readonly number[];
  const?: number;
}

export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: "integer";
  enum?: readonly number[];
  const?: number;
}

export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: "boolean";
  enum?: readonly boolean[];
  const?: boolean;
}

export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: "null";
  enum?: readonly null[];
  const?: null;
}

export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: "array";
  items?: ValueSchemaSpec;
}

export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: "object";
  properties?: ParameterSchemaSpec;
  additionalProperties?: boolean;
}

/** 万能 JSON 值 schema（编译为无 type 的注记性节点，对上游一致）。 */
export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
  type: "json";
}

export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]];
}

export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec;

/** 隐式参数根的一个属性（required 是每属性注记，不是 JSON Schema required 数组）。 */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true };

export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec;
};

/** 编译后的原始 JSON Schema 节点（宿主注入工具时直接下发）。 */
export interface RawJsonSchema {
  type?: string;
  description?: string;
  title?: string;
  default?: JsonValue;
  examples?: JsonValue;
  enum?: readonly unknown[];
  const?: unknown;
  items?: RawJsonSchema;
  properties?: Record<string, RawJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  oneOf?: RawJsonSchema[];
  [key: string]: unknown;
}

/** 工具执行上下文（宿主注入；垫片只消费 `signal`）。 */
export interface ToolRunContext {
  signal: AbortSignal;
  callId?: string;
  agent?: unknown;
  [key: string]: unknown;
}

/** 完成态结果投影（presentResult 的第二参，上游 ToolResult 子集）。 */
export interface ToolResult {
  content: ToolRenderBlock[];
  isError: boolean;
  meta?: JsonValue;
}

/** defineTool 的选项（上游 DefineToolOptions 子集）。 */
export interface DefineToolOptions<S extends ParameterSchemaSpec, V = JsonValue> {
  name: string;
  description: string;
  parameters: S;
  output: {
    schema: ValueSchemaSpec;
    render: (args: InferArgs<S>, value: V) => ToolRenderBlock[];
    presentationMeta?: (args: InferArgs<S>, value: V) => JsonValue;
  };
  /** 协作式超时预算（毫秒）；宿主负责强制。 */
  timeoutMs?: number;
  isConcurrencySafe?: (args: InferArgs<S>) => boolean;
  execute: (args: InferArgs<S>, exec: ToolRunContext) => Promise<V> | V;
  finalizeContent?: (exec: unknown, result: unknown) => ToolRenderBlock[] | undefined;
  presentCall?: (args: InferArgs<S>) => unknown;
  presentResult?: (args: InferArgs<S>, result: ToolResult) => unknown;
}

/** 宿主侧注册用的工具定义（M2/M3 以伪扩展 id 接入 owc 工具表）。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: RawJsonSchema;
  output: {
    schema: RawJsonSchema;
    render: (args: unknown, value: unknown) => ToolRenderBlock[];
    presentationMeta?: (args: unknown, value: unknown) => JsonValue;
  };
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
  execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>;
  finalizeContent?: (exec: unknown, result: unknown) => ToolRenderBlock[] | undefined;
  presentCall?: (args: unknown) => unknown;
  presentResult?: (args: unknown, result: ToolResult) => unknown;
}

/** 参数校验失败（上游 ToolArgsError 同语义；violations 为带路径的消息列表）。 */
export class ToolArgsError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`invalid tool arguments:\n${violations.map(line => `- ${line}`).join("\n")}`);
    this.name = "ToolArgsError";
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// 作者侧编译：spec → JSON Schema（未知键 fail loud）
// ---------------------------------------------------------------------------

const ANNOTATION_KEYS = ["description", "title", "default", "examples"] as const;
const SCALAR_KEYS = ["type", "enum", "const"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorError(path: string, message: string): never {
  throw new TypeError(`[dsh-tools] ${path}: ${message}`);
}

function copyAnnotations(input: Record<string, unknown>, node: RawJsonSchema, path: string) {
  for (const key of ANNOTATION_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    if (key === "description" || key === "title") {
      if (typeof input[key] !== "string") authorError(`${path}.${key}`, "must be a string");
      node[key] = input[key] as string;
    } else {
      node[key] = input[key] as JsonValue;
    }
  }
}

function compileValueSchema(input: unknown, path: string): RawJsonSchema {
  if (!isPlainObject(input)) authorError(path, "must be a plain object");
  const keys = Object.keys(input);
  if (Object.hasOwn(input, "oneOf")) {
    const allowed: string[] = [...ANNOTATION_KEYS, "oneOf"];
    for (const key of keys) {
      if (!allowed.includes(key)) authorError(`${path}.${key}`, `is not allowed on a oneOf node (allowed: ${allowed.join(", ")})`);
    }
    const list = input.oneOf;
    if (!Array.isArray(list) || list.length < 2) authorError(`${path}.oneOf`, "must be an array of at least 2 schemas");
    const node: RawJsonSchema = { oneOf: list.map((entry, index) => compileValueSchema(entry, `${path}.oneOf[${index}]`)) };
    copyAnnotations(input, node, path);
    return node;
  }
  const type = input.type;
  if (typeof type !== "string") authorError(`${path}.type`, "must be string/number/integer/boolean/null/array/object/json, or use oneOf");
  switch (type) {
    case "json": {
      const allowed: string[] = [...ANNOTATION_KEYS, "type"];
      for (const key of keys) {
        if (!allowed.includes(key)) authorError(`${path}.${key}`, `is not allowed on a json node (allowed: ${allowed.join(", ")})`);
      }
      const node: RawJsonSchema = {};
      copyAnnotations(input, node, path);
      return node;
    }
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null": {
      const allowed: string[] = [...ANNOTATION_KEYS, ...SCALAR_KEYS];
      for (const key of keys) {
        if (!allowed.includes(key)) authorError(`${path}.${key}`, `is not allowed on a ${type} node (allowed: ${allowed.join(", ")})`);
      }
      const node: RawJsonSchema = { type };
      copyAnnotations(input, node, path);
      if (Object.hasOwn(input, "enum")) {
        if (!Array.isArray(input.enum) || input.enum.length === 0) authorError(`${path}.enum`, "must be a non-empty array of scalar values");
        node.enum = [...input.enum];
      }
      if (Object.hasOwn(input, "const")) node.const = input.const;
      return node;
    }
    case "array": {
      const allowed: string[] = [...ANNOTATION_KEYS, ...SCALAR_KEYS, "items"];
      for (const key of keys) {
        if (!allowed.includes(key)) authorError(`${path}.${key}`, `is not allowed on an array node (allowed: ${allowed.join(", ")})`);
      }
      const node: RawJsonSchema = { type };
      copyAnnotations(input, node, path);
      if (Object.hasOwn(input, "items")) node.items = compileValueSchema(input.items, `${path}.items`);
      return node;
    }
    case "object": {
      const allowed: string[] = [...ANNOTATION_KEYS, ...SCALAR_KEYS, "properties", "additionalProperties"];
      for (const key of keys) {
        if (!allowed.includes(key)) authorError(`${path}.${key}`, `is not allowed on an object node (allowed: ${allowed.join(", ")})`);
      }
      const node: RawJsonSchema = { type };
      copyAnnotations(input, node, path);
      if (Object.hasOwn(input, "additionalProperties")) {
        if (typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties`, "must be a boolean");
        node.additionalProperties = input.additionalProperties;
      }
      if (Object.hasOwn(input, "properties")) {
        const compiled = compilePropertyMap(input.properties, `${path}.properties`);
        node.properties = compiled.properties;
        if (compiled.required) node.required = compiled.required;
      }
      return node;
    }
    default:
      authorError(`${path}.type`, `unsupported type "${type}"`);
  }
}

/** 编译隐式参数映射，收集每属性 `required: true` 注记。 */
function compilePropertyMap(input: unknown, path: string): { properties: Record<string, RawJsonSchema>; required?: string[] } {
  if (!isPlainObject(input)) authorError(path, "must be a plain object of property specs");
  const properties: Record<string, RawJsonSchema> = {};
  const required: string[] = [];
  for (const key of Object.keys(input)) {
    const spec = input[key];
    if (!isPlainObject(spec)) authorError(`${path}.${key}`, "must be a plain object spec");
    const { required: isRequired, ...rest } = spec as Record<string, unknown>;
    if (isRequired !== undefined && isRequired !== true) {
      authorError(`${path}.${key}.required`, "only the literal `true` is accepted");
    }
    properties[key] = compileValueSchema(rest, `${path}.${key}`);
    if (isRequired === true) required.push(key);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

/** 参数 DSL → 隐式对象根 JSON Schema（上游 parameterSchemaSpecToJsonSchema 子集）。 */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): RawJsonSchema {
  const compiled = compilePropertyMap(spec, "parameters");
  const schema: RawJsonSchema = { type: "object", properties: compiled.properties };
  if (compiled.required) schema.required = compiled.required;
  return schema;
}

/** 输出值 DSL → JSON Schema（上游 valueSchemaSpecToJsonSchema 子集）。 */
export function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): RawJsonSchema {
  return compileValueSchema(spec, "output.schema");
}

// ---------------------------------------------------------------------------
// 消费侧校验：args → violations
// ---------------------------------------------------------------------------

const SCALAR_TYPES: Record<string, (value: unknown) => boolean> = {
  string: value => typeof value === "string",
  number: value => typeof value === "number" && Number.isFinite(value),
  integer: value => typeof value === "number" && Number.isInteger(value),
  boolean: value => typeof value === "boolean",
  null: value => value === null,
};

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function validateNode(schema: RawJsonSchema, value: unknown, path: string, violations: string[]) {
  const push = (message: string) => violations.push(`${path || "(root)"} ${message}`);
  if (Object.hasOwn(schema, "const")) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) push(`must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.oneOf)) {
    const sub: string[] = [];
    let matched = false;
    for (const entry of schema.oneOf) {
      const candidate: string[] = [];
      validateNode(entry, value, path, candidate);
      if (candidate.length === 0) {
        matched = true;
        break;
      }
      sub.push(...candidate);
    }
    if (!matched) push(`must match one of the oneOf schemas (last error: ${sub[0] ?? "no match"})`);
    return;
  }
  if (schema.type !== undefined) {
    if (schema.type === "json") {
      if (!isJsonValue(value)) push("must be a lossless JSON value");
      return;
    }
    if (schema.type === "array") {
      if (!Array.isArray(value)) {
        push(`must be an array`);
        return;
      }
    } else if (schema.type === "object") {
      if (!isPlainObject(value)) {
        push(`must be an object`);
        return;
      }
    } else {
      const check = SCALAR_TYPES[schema.type];
      if (!check || !check(value)) {
        push(`must be a ${schema.type}`);
        return;
      }
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value))) {
    push(`must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => validateNode(schema.items!, entry, `${path}[${index}]`, violations));
  }
  if (schema.type === "object" && isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) push(`missing required property "${key}"`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        validateNode(propertySchema, entry, path ? `${path}.${key}` : key, violations);
      } else if (schema.additionalProperties === false) {
        push(`unknown property "${key}"`);
      }
    }
  }
}

/** 按编译后的参数 schema 校验一次调用参数，返回违规消息列表。 */
export function validateToolArgs(parameters: RawJsonSchema, args: unknown): string[] {
  const violations: string[] = [];
  validateNode(parameters, args, "", violations);
  return violations;
}

// ---------------------------------------------------------------------------
// defineTool
// ---------------------------------------------------------------------------

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

/**
 * 定义一个 dsh 工具：编译 schema、包装 execute（先校验参数）、包装展示回调（软校验）。
 * 与上游一致：`timeoutMs` 必须为正有限数；展示回调对失配日志回退通用呈现。
 */
export function defineTool<S extends ParameterSchemaSpec, V = JsonValue>(
  options: DefineToolOptions<S, V>,
): ToolDefinition {
  const {
    name, description, parameters, output,
    timeoutMs, isConcurrencySafe, execute,
    finalizeContent, presentCall, presentResult,
  } = options;
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("[dsh-tools] defineTool: name must be a non-empty string");
  }
  if (typeof execute !== "function") {
    throw new TypeError(`[dsh-tools] defineTool(${name}): execute must be a function`);
  }
  if (typeof output?.render !== "function") {
    throw new TypeError(`[dsh-tools] defineTool(${name}): output.render must be a function`);
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`[dsh-tools] defineTool(${name}): timeoutMs must be a positive finite number`);
  }

  const compiledParameters = parameterSchemaSpecToJsonSchema(parameters);
  const compiledOutput = valueSchemaSpecToJsonSchema(output.schema);
  const validate = (args: unknown): string[] => validateToolArgs(compiledParameters, args);

  const definition: ToolDefinition = {
    name,
    description,
    parameters: compiledParameters,
    output: {
      schema: compiledOutput,
      render: (args, value) => output.render(args as InferArgs<S>, value as V),
      ...(output.presentationMeta
        ? { presentationMeta: (args: unknown, value: unknown) => output.presentationMeta!(args as InferArgs<S>, value as V) }
        : {}),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const violations = validate(args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return execute(args as InferArgs<S>, exec);
    },
  };

  if (timeoutMs !== undefined) definition.timeoutMs = timeoutMs;
  if (finalizeContent) definition.finalizeContent = (exec, result) => finalizeContent(exec, result);
  if (isConcurrencySafe) {
    definition.isConcurrencySafe = (args: unknown) => {
      if (validate(args).length > 0) return false;
      return safeCall(() => isConcurrencySafe!(args as InferArgs<S>), false);
    };
  }
  if (presentCall) {
    definition.presentCall = (args: unknown) => {
      if (validate(args).length > 0) return undefined;
      return safeCall(() => presentCall!(args as InferArgs<S>), undefined);
    };
  }
  if (presentResult) {
    definition.presentResult = (args: unknown, result: ToolResult) => {
      if (validate(args).length > 0) return undefined;
      return safeCall(() => presentResult!(args as InferArgs<S>, result), undefined);
    };
  }
  return definition;
}

// ---- 类型推断辅助（结构性子集，宽松即可） ----

type InferProperty<P> = P extends { type: "string" } ? string
  : P extends { type: "number" | "integer" } ? number
  : P extends { type: "boolean" } ? boolean
  : P extends { type: "null" } ? null
  : P extends { type: "array" } ? unknown[]
  : P extends { type: "object" | "json" } ? unknown
  : P extends { oneOf: readonly unknown[] } ? unknown
  : unknown;

type RequiredKeys<S> = {
  [K in keyof S & string]: S[K] extends { required: true } ? K : never;
}[keyof S & string];

/** 参数推断：required 属性 → 必填，其余可选。 */
export type InferArgs<S> = { [K in RequiredKeys<S>]: InferProperty<S[K]> } & {
  [K in Exclude<keyof S & string, RequiredKeys<S>>]?: InferProperty<S[K]>;
};
