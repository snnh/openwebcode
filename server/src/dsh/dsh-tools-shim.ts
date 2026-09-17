/**
 * dsh 兼容层 · dsh-tools 垫片（M1，已按上游 0d1f50007f 复核对齐）
 *
 * 对 `@deepseek-ai/dsh-tools`（上游 packages/core/tools/src/schema.ts）的 `defineTool` 子集复刻：
 * - 参数 DSL（隐式开放对象根 + 每属性 `required: true` 注记）编译为 JSON Schema；作者侧
 *   约束与上游逐条一致：键白名单按节点类型收窄、object 节点必须显式声明
 *   `additionalProperties: true|false`、enum/const 必须匹配节点类型且 const ∈ enum、
 *   注记（default/examples）必须 lossless JSON、祖先链循环引用报 `is circular`；
 * - `execute(args, exec)` 前做参数校验，违规抛 `ToolArgsError`（`code: "INVALID_ARGS"`，
 *   文案 `invalid arguments: a; b`），isError 语义由宿主落；
 * - 违规文案与上游 `validateJsonSchemaValue` 逐字一致（`"<路径>" must be ...`、根路径为
 *   `"arguments"`、oneOf 要求**恰好命中一个分支**、对象/数组子树的 lossless 后置校验）；
 * - `presentCall`/`presentResult`/`isConcurrencySafe` 软校验：参数失配分别回退
 *   undefined/undefined/false；展示回调抛错一并吞掉（展示层回放不得影响主流程，
 *   比上游更宽——上游靠作者自律，不 catch）；
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

/**
 * 参数校验失败（上游同形态：`code: "INVALID_ARGS"` + 单行 message + violations 列表）。
 * 上游继承自 HarnessError；垫片无该基类，用等价的最小实现。
 */
export class ToolArgsError extends Error {
  readonly code = "INVALID_ARGS";
  /** 逐条违规消息（schema 遍历顺序）。 */
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join("; ")}`);
    this.name = "ToolArgsError";
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// 作者侧编译：spec → JSON Schema（未知键 fail loud）
// ---------------------------------------------------------------------------

const ANNOTATION_KEYS = ["description", "title", "default", "examples"] as const;
const SCHEMA_TYPES = "string/number/integer/boolean/null/array/object/json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** lossless JSON 判定（对齐上游 @deepseek-ai/dsh-util-values 的 isJsonValue）。 */
function isLosslessJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isLosslessJsonValue);
  if (isPlainObject(value)) {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every(isLosslessJsonValue);
  }
  return false;
}

/** 标量值是否匹配声明类型（作者侧 enum/const 约束用）。 */
function matchesScalarType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

/** 作者侧错误：文案与上游 value schema DSL 对齐，冠垫片前缀便于日志检索。 */
function authorError(message: string): never {
  throw new TypeError(`[dsh-tools] ${message}`);
}

function assertAuthorKeys(input: Record<string, unknown>, path: string, allowed: readonly string[]) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
  }
}

/** 循环引用防护：按祖先链判定（上游 compile 的 `is circular`）。 */
function withAncestor<T>(input: Record<string, unknown>, path: string, ancestors: Set<object>, compile: () => T): T {
  if (ancestors.has(input)) authorError(`${path} is circular`);
  ancestors.add(input);
  try {
    return compile();
  } finally {
    ancestors.delete(input);
  }
}

function copyAnnotations(input: Record<string, unknown>, node: RawJsonSchema, path: string) {
  for (const key of ANNOTATION_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    if (key === "description" || key === "title") {
      if (typeof input[key] !== "string") authorError(`${path}.${key} must be a string`);
      node[key] = input[key] as string;
    } else {
      if (!isLosslessJsonValue(input[key])) authorError(`${path}.${key} annotation must be lossless JSON data`);
      node[key] = input[key] as JsonValue;
    }
  }
}

/** 标量节点的 enum/const 约束（对齐上游 raw-schema 边界断言）。 */
function copyScalarConstraints(input: Record<string, unknown>, node: RawJsonSchema, path: string, type: string) {
  if (Object.hasOwn(input, "enum")) {
    const list = input.enum;
    if (!Array.isArray(list) || list.length === 0 || !list.every(entry => matchesScalarType(type, entry))) {
      authorError(`${path}.enum must be a non-empty array of ${type} values`);
    }
    node.enum = [...list] as readonly unknown[];
  }
  if (Object.hasOwn(input, "const")) {
    if (!matchesScalarType(type, input.const)) authorError(`${path}.const must be a ${type} value`);
    if (Array.isArray(node.enum) && !node.enum.includes(input.const)) {
      authorError(`${path}.const must be one of ${path}.enum when both are declared`);
    }
    node.const = input.const;
  }
}

function compileValueSchema(input: unknown, path: string, ancestors: Set<object>, allowRequired: boolean): RawJsonSchema {
  if (!isPlainObject(input)) authorError(`${path} must be a value schema object`);
  return withAncestor(input, path, ancestors, () => {
    const annotationKeys: string[] = [...ANNOTATION_KEYS, ...allowRequired ? ["required"] : []];
    if (Object.hasOwn(input, "required") && input.required !== true) authorError(`${path}.required must be true when present`);
    if (Object.hasOwn(input, "oneOf")) {
      assertAuthorKeys(input, path, [...annotationKeys, "oneOf", "type"]);
      if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
      const list = input.oneOf;
      if (!Array.isArray(list) || list.length < 2) authorError(`${path}.oneOf must be an array of at least two value schemas`);
      const node: RawJsonSchema = {
        oneOf: list.map((entry, index) => compileValueSchema(entry, `${path}.oneOf[${index}]`, ancestors, false)),
      };
      copyAnnotations(input, node, path);
      return node;
    }
    const type = input.type;
    switch (type) {
      case "json": {
        assertAuthorKeys(input, path, [...annotationKeys, "type"]);
        const node: RawJsonSchema = {};
        copyAnnotations(input, node, path);
        return node;
      }
      case "string":
      case "number":
      case "integer":
      case "boolean":
      case "null": {
        assertAuthorKeys(input, path, [...annotationKeys, "type", "enum", "const"]);
        const node: RawJsonSchema = { type };
        copyAnnotations(input, node, path);
        copyScalarConstraints(input, node, path, type);
        return node;
      }
      case "array": {
        assertAuthorKeys(input, path, [...annotationKeys, "type", "items"]);
        const node: RawJsonSchema = { type };
        copyAnnotations(input, node, path);
        if (Object.hasOwn(input, "items")) node.items = compileValueSchema(input.items, `${path}.items`, ancestors, false);
        return node;
      }
      case "object": {
        assertAuthorKeys(input, path, [...annotationKeys, "type", "properties", "additionalProperties"]);
        if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") {
          authorError(`${path}.additionalProperties must be explicitly true or false`);
        }
        const node: RawJsonSchema = { type, additionalProperties: input.additionalProperties as boolean };
        copyAnnotations(input, node, path);
        if (Object.hasOwn(input, "properties")) {
          const compiled = compilePropertyMap(input.properties, `${path}.properties`, ancestors);
          node.properties = compiled.properties;
          if (compiled.required) node.required = compiled.required;
        }
        return node;
      }
      default:
        authorError(`${path}.type must be ${SCHEMA_TYPES}, or use oneOf`);
    }
  });
}

/** 编译隐式参数映射，收集每属性 `required: true` 注记。 */
function compilePropertyMap(input: unknown, path: string, ancestors: Set<object>): { properties: Record<string, RawJsonSchema>; required?: string[] } {
  if (!isPlainObject(input)) authorError(`${path} must be an object of value schemas`);
  return withAncestor(input, path, ancestors, () => {
    const properties: Record<string, RawJsonSchema> = {};
    const required: string[] = [];
    for (const key of Object.keys(input)) {
      const spec = input[key];
      properties[key] = compileValueSchema(spec, `${path}.${key}`, ancestors, true);
      if (isPlainObject(spec) && spec.required === true) required.push(key);
    }
    return required.length > 0 ? { properties, required } : { properties };
  });
}

/** 参数 DSL → 隐式对象根 JSON Schema（上游 parameterSchemaSpecToJsonSchema 子集）。 */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): RawJsonSchema {
  const compiled = compilePropertyMap(spec, "parameters", new Set<object>());
  const schema: RawJsonSchema = { type: "object", properties: compiled.properties };
  if (compiled.required) schema.required = compiled.required;
  return schema;
}

/** 输出值 DSL → JSON Schema（上游 valueSchemaSpecToJsonSchema 子集）。 */
export function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): RawJsonSchema {
  return compileValueSchema(spec, "schema", new Set<object>(), false);
}

// ---------------------------------------------------------------------------
// 消费侧校验：args → violations
// ---------------------------------------------------------------------------
/** 上游诊断路径：根标签为 "arguments"（validateArgs 的空路径哨兵）。 */
function diagnosticPath(path: string): string {
  return path === "" ? "arguments" : path;
}

/** 对象属性路径（根层不加前导点，对齐上游 propertyPath）。 */
function propertyPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** 校验一个节点，把违规消息按上游文案写入 violations（深度优先、逐节点收敛）。 */
function validateNode(schema: RawJsonSchema, value: unknown, path: string, violations: string[]) {
  const label = `"${diagnosticPath(path)}"`;
  if (Array.isArray(schema.oneOf)) {
    // 上游语义：恰好命中一个分支，否则只报命中数（分支自身错误不外露）。
    let matches = 0;
    for (const branch of schema.oneOf) {
      const branchViolations: string[] = [];
      validateNode(branch, value, path, branchViolations);
      if (branchViolations.length === 0) matches++;
    }
    if (matches !== 1) violations.push(`${label} must match exactly one oneOf branch (matched ${matches})`);
    return;
  }
  const type = schema.type;
  if (type === undefined) {
    // 注记性节点（作者侧 `json` 编译产物）：只要求 lossless JSON。
    if (!isLosslessJsonValue(value)) violations.push(`${label} must be a lossless JSON value`);
    return;
  }
  switch (type) {
    case "object": {
      if (!isPlainObject(value)) {
        violations.push(`${label} must be an object`);
        return;
      }
      const before = violations.length;
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`missing required property "${propertyPath(path, key)}"`);
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
        validateNode(child, value[key], propertyPath(path, key), violations);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) {
            violations.push(`"${propertyPath(path, key)}" is not a declared property (additionalProperties: false)`);
          }
        }
      }
      if (violations.length === before && !isLosslessJsonValue(value)) {
        violations.push(`${label} must be a lossless JSON object`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        violations.push(`${label} must be an array`);
        return;
      }
      const before = violations.length;
      if (schema.items) {
        value.forEach((entry, index) => validateNode(schema.items!, entry, `${path}[${index}]`, violations));
      }
      if (violations.length === before && !isLosslessJsonValue(value)) {
        violations.push(`${label} must be a dense lossless JSON array`);
      }
      return;
    }
    case "string":
      if (typeof value !== "string") { violations.push(`${label} must be a string`); return; }
      break;
    case "number":
      if (typeof value !== "number") { violations.push(`${label} must be a number`); return; }
      if (!Number.isFinite(value)) { violations.push(`${label} must be a finite JSON number`); return; }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) { violations.push(`${label} must be an integer`); return; }
      break;
    case "boolean":
      if (typeof value !== "boolean") { violations.push(`${label} must be a boolean`); return; }
      break;
    case "null":
      if (value !== null) { violations.push(`${label} must be null`); return; }
      break;
    default:
      if (!isLosslessJsonValue(value)) violations.push(`${label} must be a lossless JSON value`);
      return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${label} must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    violations.push(`${label} must be ${JSON.stringify(schema.const)}`);
  }
}

/** 按编译后的参数 schema 校验一次调用参数，返回违规消息列表（上游 validateArgs 语义）。 */
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
    // 上游同款文案与错误类型（plain Error）
    throw new Error(`defineTool(${name}): timeoutMs must be a positive finite number`);
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
