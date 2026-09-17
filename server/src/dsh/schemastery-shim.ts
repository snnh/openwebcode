/**
 * dsh 兼容层 · schemastery 垫片（M1）
 *
 * 对 `@deepseek-ai/schemastery`（上游 vendor/schemastery，v3.18.2 fork）的子集复刻：
 * 提供 dsh 插件 `Config` 声明所需的链式 schema DSL 与解析语义，未覆盖的特性在
 * 构造期 fail loud（抛 UnsupportedSchemaError），绝不静默偏离上游语义。
 *
 * 语义对齐钉版 0d1f50007f 的 vendor/schemastery/src/index.ts：
 * - nullable 数据 + required → 报错；否则取 meta.default（深拷贝），再否则原样透传；
 * - object 解析保留输入中的多余键（strict 模式除外）；缺席的可选键且解析值为 null 时不产出；
 * - union 依序尝试首个成功分支，全部失败时报 "expected <list> but got <json>"；
 * - intersect 逐分支 strict 解析后按对象合并，类型冲突报错；
 * - `~standard` 接口供 cordis Config 校验使用（仅支持同步校验）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-namespace -- 垫片忠实复刻上游 schemastery 的宽松类型面（any/namespace 为上游公开 API 形态），逐行 disable 会淹没移植代码的可读性 */

/** 上游构造期直接抛出的不支持特性错误（区别于数据校验的 ValidationError）。 */
export class UnsupportedSchemaError extends TypeError {
  constructor(message: string) {
    super(`[dsh-shim] schemastery 特性未支持: ${message}`);
    this.name = "UnsupportedSchemaError";
  }
}

/** 与上游同构的校验错误：message 带 `$` 路径前缀（上游 ValidationError）。 */
export class ValidationError extends TypeError {
  name = "ValidationError";
  path: Schemastery.PropertyKey[];

  constructor(message: string, options: { path?: Schemastery.PropertyKey[] } = {}) {
    let prefix = "$";
    for (const segment of options.path ?? []) {
      if (typeof segment === "string") prefix += `.${segment}`;
      else if (typeof segment === "number") prefix += `[${segment}]`;
      else prefix += `[Symbol(${String(segment)})]`;
    }
    if (prefix.startsWith(".")) prefix = prefix.slice(1);
    super((prefix === "$" ? "" : `${prefix} `) + message);
    this.path = options.path ?? [];
  }
}

const K_VALIDATION_ERROR = Symbol.for("schemastery.validationError");
Object.defineProperty(ValidationError.prototype, K_VALIDATION_ERROR, { value: true });

const K_SCHEMA = Symbol.for("schemastery.schema");

function isNullable(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** 深拷贝（仅支持 lossless JSON 数据；函数/循环引用等场景按上游 clone 的失败语义向上抛）。 */
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(entry => clone(entry)) as unknown as T;
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = clone(entry);
    return result as unknown as T;
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every(key => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

export declare namespace Schemastery {
  type PropertyKey = string | number | symbol;
  interface Meta<T = unknown> {
    required?: boolean;
    hidden?: boolean;
    disabled?: boolean;
    pattern?: { source: string; flags: string };
    default?: T;
    description?: string;
    link?: string;
    comment?: string;
    max?: number;
    min?: number;
    step?: number;
    role?: string;
    extra?: Record<string, unknown>;
    badges?: { text: string; type: string }[];
    [key: string]: unknown;
  }
  interface Options {
    path?: PropertyKey[];
    ignore?: (data: unknown, schema: Schemastery) => boolean;
    autofix?: boolean;
  }
  type Resolve = (
    data: unknown,
    schema: Schemastery,
    options: Options,
    strict?: boolean,
  ) => [value: unknown, adapted?: unknown];
}

export interface Schemastery {
  <T = unknown>(data: unknown, options?: { path?: Schemastery.PropertyKey[] }): T;
  type: string;
  meta: Schemastery.Meta;
  inner?: Schemastery;
  sKey?: Schemastery;
  list?: Schemastery[];
  dict?: Record<string, Schemastery>;
  bits?: Record<string, number>;
  callback?: (data: unknown) => unknown;
  value?: unknown;
  constructor?: unknown;
  builder?: () => Schemastery;
  /** uid（跨副本计数）。 */
  uid: number;
  toString: (inline?: boolean) => string;
  toJSON: () => never;
  set: (key: string, value: unknown) => void;
  push: (value: unknown) => void;
  i18n: (messages: unknown) => Schemastery;
  extra: (key: string, value: unknown) => Schemastery;
  deprecated: () => Schemastery;
  experimental: () => Schemastery;
  pattern: (regexp: RegExp) => Schemastery;
  role: (role: string, extra?: Record<string, unknown>) => Schemastery;
  required: (value?: boolean) => Schemastery;
  hidden: (value?: boolean) => Schemastery;
  disabled: (value?: boolean) => Schemastery;
  default: (value: unknown) => Schemastery;
  link: (value: string) => Schemastery;
  comment: (value: string) => Schemastery;
  description: (value: string) => Schemastery;
  max: (value: number) => Schemastery;
  min: (value: number) => Schemastery;
  step: (value: number) => Schemastery;
  [key: string]: unknown;
}

interface SchemasteryStatic {
  (options: Schemastery): Schemastery;
  new (options: Schemastery): Schemastery;
  prototype: Schemastery;
  ValidationError: typeof ValidationError;
  resolve: Schemastery.Resolve;
  from: (source: unknown) => Schemastery;
  extend: (type: string, resolve: Schemastery.Resolve) => void;
  lazy: () => Schemastery;
  natural: () => Schemastery;
  percent: () => Schemastery;
  is: (constructor: unknown) => Schemastery;
  date: () => Schemastery;
  regExp: (flag?: string) => Schemastery;
  arrayBuffer: (encoding?: "hex" | "base64") => Schemastery;
  any: () => Schemastery;
  never: () => Schemastery;
  const: (value: unknown) => Schemastery;
  string: () => Schemastery;
  number: () => Schemastery;
  boolean: () => Schemastery;
  function: () => Schemastery;
  array: (inner?: unknown) => Schemastery;
  dict: (inner?: unknown, sKey?: unknown) => Schemastery;
  object: (dict: Record<string, unknown>) => Schemastery;
  union: (list: unknown[]) => Schemastery;
  intersect: (list: unknown[]) => Schemastery;
  transform: (inner: unknown, callback: (data: unknown) => unknown) => Schemastery;
}

const resolvers: Record<string, Schemastery.Resolve> = {};
const formatters: Record<string, (schema: Schemastery, inline?: boolean) => string> = {};

/** 全局 uid 计数（与上游一致使用 globalThis 上的计数器，避免跨副本 uid 冲突）。 */
declare global {
  var __schemastery_index__: number;
}
globalThis.__schemastery_index__ ??= 0;

const Schema = function (options: Schemastery): Schemastery {
  const schema = function (data: unknown, resolveOptions: Schemastery.Options = {}) {
    return Schema.resolve(data, schema, resolveOptions)[0];
  } as unknown as Schemastery;

  Object.assign(schema, options);
  Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
  Object.setPrototypeOf(schema, Schema.prototype);
  schema.meta ??= {};
  schema.toString = schema.toString.bind(schema);
  return schema;
} as unknown as SchemasteryStatic;

Schema.prototype = Object.create(Function.prototype) as unknown as Schemastery;

Object.defineProperty(Schema.prototype, K_SCHEMA, { value: true });

Object.defineProperty(Schema.prototype, "~standard", {
  get(this: Schemastery) {
    return {
      version: 1,
      vendor: "schemastery",
      validate: (value: unknown): { value: unknown } | { issues: { message: string; path?: Schemastery.PropertyKey[] }[] } => {
        try {
          return { value: Schema.resolve(value, this, {})[0] };
        } catch (error) {
          if (error instanceof ValidationError) {
            return { issues: [{ message: error.message, path: error.path }] };
          }
          throw error;
        }
      },
    };
  },
});

Schema.ValidationError = ValidationError;

Schema.prototype.toJSON = function (this: Schemastery) {
  // 上游依赖 __schemastery_refs__ 做跨进程序列化；垫片不需要，直接 fail loud。
  throw new UnsupportedSchemaError("toJSON()（跨进程 schema 序列化）");
};

Schema.prototype.set = function (this: Schemastery, key: string, value: unknown) {
  this[key] = value;
};

Schema.prototype.push = function (this: Schemastery, value: unknown) {
  this.list ??= [];
  this.list.push(value as Schemastery);
};

Schema.prototype.i18n = function (this: Schemastery, messages: unknown) {
  // UI 文案映射对 Config 校验无影响，接受并忽略。
  this.meta.i18n = messages;
  return this;
};

Schema.prototype.extra = function (this: Schemastery, key: string, value: unknown) {
  const schema = Schema(this);
  const base = schema.meta.extra ?? {};
  schema.meta = { ...schema.meta, extra: { ...base, [key]: value } };
  return schema;
};

// 布尔型 meta 修饰器（required/hidden/disabled），默认值为 true。
for (const key of ["required", "hidden", "disabled"] as const) {
  Object.assign(Schema.prototype, {
    [key](this: Schemastery, value = true) {
      const schema = Schema(this);
      schema.meta = { ...schema.meta, [key]: value };
      return schema;
    },
  });
}

Schema.prototype.deprecated = function (this: Schemastery) {
  const schema = Schema(this);
  schema.meta = { ...schema.meta, badges: [...schema.meta.badges ?? [], { text: "deprecated", type: "danger" }] };
  return schema;
};

Schema.prototype.experimental = function (this: Schemastery) {
  const schema = Schema(this);
  schema.meta = { ...schema.meta, badges: [...schema.meta.badges ?? [], { text: "experimental", type: "warning" }] };
  return schema;
};

Schema.prototype.pattern = function (this: Schemastery, regexp: RegExp) {
  const schema = Schema(this);
  schema.meta = { ...schema.meta, pattern: { source: regexp.source, flags: regexp.flags } };
  return schema;
};

Schema.prototype.toString = function (this: Schemastery, inline?: boolean) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};

Schema.prototype.role = function (this: Schemastery, role: string, extra?: Record<string, unknown>) {
  const schema = Schema(this);
  const meta: Schemastery.Meta = { ...schema.meta, role };
  if (extra !== undefined) meta.extra = extra;
  schema.meta = meta;
  return schema;
};

for (const key of ["default", "link", "comment", "description", "max", "min", "step"] as const) {
  Object.assign(Schema.prototype, {
    [key](this: Schemastery, value: never) {
      const schema = Schema(this);
      schema.meta = { ...schema.meta, [key]: value };
      return schema;
    },
  });
}

Schema.extend = function (type: string, resolve: Schemastery.Resolve) {
  resolvers[type] = resolve;
};

Schema.resolve = function resolve(data: unknown, schema: Schemastery, options: Schemastery.Options = {}, strict = false): [unknown, unknown?] {
  if (!schema) return [data];
  if (options.ignore?.(data, schema)) return [data];

  if (isNullable(data)) {
    if (schema.meta.required) throw new ValidationError(`missing required value`, options);
    let current: Schemastery | undefined = schema;
    let fallback: unknown = schema.meta.default;
    while (current?.type === "intersect" && isNullable(fallback)) {
      current = current.list?.[0];
      fallback = current?.meta.default;
    }
    if (isNullable(fallback)) return [data];
    data = clone(fallback);
  }

  const callback = resolvers[schema.type];
  if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);

  try {
    return callback(data, schema, options, strict);
  } catch (error) {
    if (!schema.meta.loose) throw error;
    return [schema.meta.default];
  }
};

function isSchema(value: unknown): value is Schemastery {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && (value as Record<symbol, unknown>)[K_SCHEMA] === true;
}

Schema.from = function from(source: unknown): Schemastery {
  if (isNullable(source)) return Schema.any();
  if (["string", "number", "boolean"].includes(typeof source)) return Schema.const(source).required();
  if (isSchema(source)) return source;
  if (typeof source === "function") {
    if (source === String) return Schema.string().required();
    if (source === Number) return Schema.number().required();
    if (source === Boolean) return Schema.boolean().required();
    throw new UnsupportedSchemaError(`Schema.from(${(source as { name?: string }).name ?? "function"})`);
  }
  throw new UnsupportedSchemaError(`cannot infer schema from ${String(source)}`);
};

Schema.is = function is(): Schemastery {
  throw new UnsupportedSchemaError("Schema.is()（类实例校验）");
};
Schema.lazy = function lazy(): Schemastery {
  throw new UnsupportedSchemaError("Schema.lazy()");
};
Schema.date = function date(): Schemastery {
  throw new UnsupportedSchemaError("Schema.date()");
};
Schema.regExp = function regExp(): Schemastery {
  throw new UnsupportedSchemaError("Schema.regExp()");
};
Schema.arrayBuffer = function arrayBuffer(): Schemastery {
  throw new UnsupportedSchemaError("Schema.arrayBuffer()");
};

// ---- 内建类型解析器（对齐上游） ----

function checkWithinRange(data: number, meta: Schemastery.Meta, description: string, options: Schemastery.Options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta;
  if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
  if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}

Schema.extend("any", data => [data]);

Schema.extend("never", (data, _, options) => {
  throw new ValidationError(`expected nullable but got ${data}`, options);
});

Schema.extend("const", (data, { value }, options) => {
  if (deepEqual(data, value)) return [value];
  throw new ValidationError(`expected ${String(value)} but got ${String(data)}`, options);
});

Schema.extend("string", (data, { meta }, options) => {
  if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
    if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
  }
  checkWithinRange(data.length, meta, "string length", options);
  return [data];
});

/** 上游 decimalShift/isMultipleOf 的逐字移植（十进制小数步进的精确整除判定）。 */
function decimalShift(data: number, digits: number) {
  const str = data.toString();
  if (str.includes("e")) return data * Math.pow(10, digits);
  const index = str.indexOf(".");
  if (index === -1) return data * Math.pow(10, digits);
  const frac = str.slice(index + 1);
  const integer = str.slice(0, index);
  if (frac.length <= digits) return Number(integer + frac.padEnd(digits, "0"));
  return Number(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}

function isMultipleOf(data: number, min: number, step: number) {
  step = Math.abs(step);
  if (!/^\d+\.\d+$/.test(step.toString())) {
    return (data - min) % step === 0;
  }
  const index = step.toString().indexOf(".");
  const digits = step.toString().slice(index + 1).length;
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}

Schema.extend("number", (data, { meta }, options) => {
  if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
  checkWithinRange(data, meta, "number", options);
  const { step } = meta;
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) {
    throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
  }
  return [data];
});

Schema.extend("boolean", (data, _, options) => {
  if (typeof data === "boolean") return [data];
  throw new ValidationError(`expected boolean but got ${data}`, options);
});

Schema.extend("function", (data, _, options) => {
  if (typeof data === "function") return [data];
  throw new ValidationError(`expected function but got ${data}`, options);
});

function resolveProperty(data: any, key: PropertyKey, schema: Schemastery, options: Schemastery.Options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, { ...options, path: [...options.path ?? [], key] });
    if (adapted !== undefined) data[key] = adapted;
    return value;
  } catch (error) {
    if (!options?.autofix) throw error;
    delete data[key];
    return schema.meta.default;
  }
}

type PropertyKey = string | number | symbol;

function mergeInto(result: Record<string, unknown>, data: unknown) {
  if (!isPlainObject(data)) return;
  for (const key in data) {
    if (key in result) continue;
    result[key] = data[key];
  }
}

Schema.extend("array", (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  checkWithinRange(data.length, meta, "array length", options, !isNullable(inner!.meta.default));
  return [data.map((_, index) => resolveProperty(data, index, inner!, options))];
});

Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result: Record<string, unknown> = {};
  for (const key in data) {
    let rKey: string;
    try {
      rKey = Schema.resolve(key, sKey!, options)[0] as string;
    } catch (error) {
      if (strict) continue;
      throw error;
    }
    result[rKey] = resolveProperty(data, key, inner!, options);
    (data as Record<string, unknown>)[rKey] = data[key];
    if (key !== rKey) delete data[key];
  }
  return [result];
});

Schema.extend("object", (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result: Record<string, unknown> = {};
  for (const key in dict) {
    const value = resolveProperty(data, key, dict![key]!, options);
    if (!isNullable(value) || key in data) result[key] = value;
  }
  if (!strict) mergeInto(result, data);
  return [result];
});

Schema.extend("union", (data, { list, toString }, options, strict) => {
  const messages: unknown[] = [];
  for (const inner of list!) {
    try {
      return Schema.resolve(data, inner, options, strict);
    } catch (error) {
      messages.push(error);
    }
  }
  throw new ValidationError(`expected ${toString!()} but got ${JSON.stringify(data)}`, options);
});

Schema.extend("intersect", (data, { list, toString }, options, strict) => {
  if (!list!.length) return [data];
  let result: unknown;
  for (const inner of list!) {
    const value = Schema.resolve(data, inner, options, true)[0];
    if (isNullable(value)) continue;
    if (isNullable(result)) {
      result = value;
    } else if (typeof result !== typeof value) {
      throw new ValidationError(`expected ${toString!()} but got ${JSON.stringify(data)}`, options);
    } else if (typeof value === "object" && value !== null && typeof result === "object" && result !== null) {
      mergeInto(result as Record<string, unknown>, value);
    } else if (result !== value) {
      throw new ValidationError(`expected ${toString!()} but got ${JSON.stringify(data)}`, options);
    }
  }
  if (!strict && isPlainObject(data)) mergeInto(result as Record<string, unknown>, data);
  return [result];
});

Schema.extend("transform", (data, { inner, callback }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner!, options, true);
  return [callback!(result), callback!(adapted)];
});

// ---- 构造器与格式化器 ----

interface DefineMethodSpec {
  /** 构造参数按序赋给的 schema 字段；`dict`/`list`/`inner`/`sKey` 有专用转换。 */
  keys: string[];
  format: (schema: Schemastery, inline?: boolean) => string;
}

function defineMethod(name: string, spec: DefineMethodSpec) {
  formatters[name] = spec.format;
  Object.assign(Schema, {
    [name](...args: unknown[]): Schemastery {
      const schema = new Schema({ type: name } as Schemastery);
      spec.keys.forEach((key, index) => {
        switch (key) {
          case "sKey": schema.sKey = (args[index] as Schemastery) ?? Schema.string(); break;
          case "inner": schema.inner = Schema.from(args[index]); break;
          case "list": schema.list = (args[index] as unknown[]).map(Schema.from); break;
          case "dict": {
            const input = args[index] as Record<string, unknown>;
            const dict: Record<string, Schemastery> = {};
            for (const entry in input) dict[entry] = Schema.from(input[entry]);
            schema.dict = dict;
            break;
          }
          case "value": schema.value = args[index]; break;
          case "callback": schema.callback = args[index] as (data: unknown) => unknown; break;
          default: throw new UnsupportedSchemaError(`Schema.${name}() 的参数 "${key}"`);
        }
      });
      if (name === "object" || name === "dict") {
        schema.meta.default = {};
      } else if (name === "array") {
        schema.meta.default = [];
      }
      return schema;
    },
  });
}

defineMethod("any", { keys: [], format: () => "any" });
defineMethod("never", { keys: [], format: () => "never" });
defineMethod("const", { keys: ["value"], format: ({ value }) => typeof value === "string" ? JSON.stringify(value) : String(value) });
defineMethod("string", { keys: [], format: () => "string" });
defineMethod("number", { keys: [], format: () => "number" });
defineMethod("boolean", { keys: [], format: () => "boolean" });
defineMethod("function", { keys: [], format: () => "function" });
defineMethod("array", { keys: ["inner"], format: ({ inner }) => `${inner!.toString(true)}[]` });
defineMethod("dict", { keys: ["inner", "sKey"], format: ({ inner, sKey }) => `{ [key: ${sKey!.toString()}]: ${inner!.toString()} }` });

defineMethod("object", {
  keys: ["dict"],
  format: ({ dict }) => {
    if (Object.keys(dict!).length === 0) return "{}";
    return `{ ${Object.entries(dict!).map(([key, inner]) => `${key}${inner!.meta.required ? "" : "?"}: ${inner!.toString()}`).join(", ")} }`;
  },
});

defineMethod("union", {
  keys: ["list"],
  format: ({ list }, inline) => {
    const result = list!.map(({ toString: format }) => format()).join(" | ");
    return inline ? `(${result})` : result;
  },
});

defineMethod("intersect", {
  keys: ["list"],
  format: ({ list }) => list!.map(inner => inner.toString(true)).join(" & "),
});

defineMethod("transform", {
  keys: ["inner", "callback"],
  format: ({ inner }, isInner) => inner!.toString(isInner),
});

Schema.natural = function natural() {
  return Schema.number().step(1).min(0);
};

Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role("slider");
};

export default Schema as SchemasteryStatic;
export { Schema };
