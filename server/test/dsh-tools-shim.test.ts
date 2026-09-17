/** dsh 垫片单测 · dsh-tools 子集（M1）：defineTool 编译/校验/展示回退 */
import { describe, expect, it } from "vitest";
import {
  ToolArgsError,
  defineTool,
  parameterSchemaSpecToJsonSchema,
  validateToolArgs,
  valueSchemaSpecToJsonSchema,
} from "../src/dsh/dsh-tools-shim.js";
import type { ParameterSchemaSpec } from "../src/dsh/dsh-tools-shim.js";

const noopSignal = new AbortController().signal;

function exec() {
  return { signal: noopSignal };
}

describe("dsh-tools-shim 参数编译", () => {
  it("隐式对象根：per-property required → JSON Schema required 数组", () => {
    const schema = parameterSchemaSpecToJsonSchema({
      a: { type: "string", required: true, description: "A" },
      b: { type: "number" },
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        a: { type: "string", description: "A" },
        b: { type: "number" },
      },
      required: ["a"],
    });
  });

  it("嵌套 object/array/oneOf/json", () => {
    const schema = valueSchemaSpecToJsonSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        list: { type: "array", items: { type: "integer" } },
        choice: { oneOf: [{ type: "string" }, { type: "number" }] },
        data: { type: "json", description: "any" },
      },
    });
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    const properties = schema.properties!;
    expect(properties.list.items).toEqual({ type: "integer" });
    expect(properties.choice.oneOf).toHaveLength(2);
    expect(properties.data).toEqual({ description: "any" });
  });

  it("object 节点必须显式声明 additionalProperties（上游同款 fail loud）", () => {
    expect(() => valueSchemaSpecToJsonSchema({
      type: "object",
      properties: { text: { type: "string" } },
    } as never)).toThrow(/additionalProperties must be explicitly true or false/);
    expect(() => valueSchemaSpecToJsonSchema({
      type: "object",
      additionalProperties: "no",
      properties: {},
    } as never)).toThrow(/additionalProperties must be explicitly true or false/);
  });

  it("循环引用 fail loud（上游 is circular）", () => {
    const spec: Record<string, unknown> = { name: { type: "string" } };
    spec.self = spec;
    expect(() => parameterSchemaSpecToJsonSchema(spec as never)).toThrow(/parameters.self is circular/);
    const node: Record<string, unknown> = { type: "object", additionalProperties: false };
    node.properties = { inner: node };
    expect(() => valueSchemaSpecToJsonSchema(node as never)).toThrow(/is circular/);
  });

  it("array 节点不接受 enum/const；标量 enum/const 必须匹配类型", () => {
    expect(() => parameterSchemaSpecToJsonSchema({
      a: { type: "array", items: { type: "string" }, enum: [["x"]] },
    } as never)).toThrow(/schema DSL/);
    expect(() => parameterSchemaSpecToJsonSchema({
      a: { type: "string", const: 1 },
    } as never)).toThrow(/const must be a string value/);
    expect(() => valueSchemaSpecToJsonSchema({
      type: "object",
      additionalProperties: false,
      properties: { k: { type: "string", const: "b", enum: ["a"] } },
    } as never)).toThrow(/const must be one of/);
    expect(() => valueSchemaSpecToJsonSchema({
      type: "object",
      additionalProperties: false,
      properties: { k: { type: "string", default: new Date() } },
    } as never)).toThrow(/annotation must be lossless JSON data/);
  });

  it("作者侧未知键 fail loud", () => {
    expect(() => parameterSchemaSpecToJsonSchema({
      a: { type: "string", unknownKey: 1 } as unknown as ParameterSchemaSpec,
    })).toThrow(/unknownKey/);
    expect(() => parameterSchemaSpecToJsonSchema({
      a: { type: "string", required: false } as unknown as ParameterSchemaSpec,
    })).toThrow(/required/);
    expect(() => valueSchemaSpecToJsonSchema({ oneOf: [{ type: "string" }] } as never)).toThrow(/oneOf/);
    expect(() => valueSchemaSpecToJsonSchema({ type: "map" } as never)).toThrow(/must be string\/number\/integer\/boolean\/null\/array\/object\/json, or use oneOf/);
    expect(() => valueSchemaSpecToJsonSchema({
      type: "string",
      oneOf: [{ type: "string" }, { type: "number" }],
    } as never)).toThrow(/cannot declare both type and oneOf/);
  });
});

describe("dsh-tools-shim 参数校验", () => {
  const schema = parameterSchemaSpecToJsonSchema({
    name: { type: "string", required: true },
    level: { type: "integer", enum: [1, 2, 3] },
    tags: { type: "array", items: { type: "string" } },
    meta: { type: "object", additionalProperties: false, properties: { deep: { type: "boolean" } } },
    any: { type: "json" },
  });

  it("合法参数零违规", () => {
    expect(validateToolArgs(schema, {
      name: "x", level: 2, tags: ["a"], meta: { deep: true }, any: { k: [1] },
    })).toEqual([]);
  });

  it("类型/枚举/嵌套/额外键违规带路径", () => {
    const violations = validateToolArgs(schema, {
      level: 4,
      tags: ["a", 5],
      meta: { deep: "yes", extra: 1 },
    });
    const text = violations.join("\n");
    // 文案与上游逐字一致（引号路径 + 声明式 additionalProperties 措辞）
    expect(text).toContain("missing required property \"name\"");
    expect(text).toContain("\"level\" must be one of [1,2,3]");
    expect(text).toContain("\"tags[1]\" must be a string");
    expect(text).toContain("\"meta.deep\" must be a boolean");
    expect(text).toContain("\"meta.extra\" is not a declared property (additionalProperties: false)");
  });

  it("json 类型接受任意 lossless JSON；拒非 JSON 值；integer 拒绝小数", () => {
    expect(validateToolArgs(schema, { name: "x", any: [1, "a", null, { b: true }] })).toEqual([]);
    expect(validateToolArgs(schema, { name: "x", any: new Date() }).join("\n"))
      .toContain("\"any\" must be a lossless JSON value");
    expect(validateToolArgs(schema, { name: "x", any: Number.NaN }).join("\n"))
      .toContain("\"any\" must be a lossless JSON value");
    expect(validateToolArgs(schema, { name: "x", level: 1.5 }).join("\n")).toContain("must be an integer");
  });

  it("根非对象：\"arguments\" 标签（上游诊断路径）", () => {
    expect(validateToolArgs(schema, "nope")).toEqual(["\"arguments\" must be an object"]);
  });

  it("required 属性显式 undefined 视同缺席（上游语义）", () => {
    expect(validateToolArgs(schema, { name: undefined }))
      .toEqual(["missing required property \"name\""]);
  });

  it("oneOf 必须恰好命中一个分支", () => {
    const schema2 = parameterSchemaSpecToJsonSchema({
      v: { oneOf: [{ type: "string" }, { type: "number" }] },
    });
    expect(validateToolArgs(schema2, { v: "s" })).toEqual([]);
    expect(validateToolArgs(schema2, { v: 3 })).toEqual([]);
    expect(validateToolArgs(schema2, { v: true }))
      .toEqual(["\"v\" must match exactly one oneOf branch (matched 0)"]);
    // 重叠分支：上游拒绝（matched 2）
    const overlap = parameterSchemaSpecToJsonSchema({
      v: { oneOf: [{ type: "string" }, { type: "string", enum: ["a"] }] },
    });
    expect(validateToolArgs(overlap, { v: "a" }))
      .toEqual(["\"v\" must match exactly one oneOf branch (matched 2)"]);
  });
});

describe("dsh-tools-shim defineTool 行为", () => {
  const tool = defineTool({
    name: "demo_tool",
    description: "演示工具",
    parameters: {
      query: { type: "string", required: true, description: "查询词" },
      limit: { type: "number" },
    },
    output: {
      schema: { type: "json" },
      render: (args: { query: string }, value: unknown) => [{ type: "text", text: `${args.query}=${String(value)}` }],
    },
    timeoutMs: 1000,
    isConcurrencySafe: (args: { query: string }) => args.query.length > 1,
    execute: async (args: { query: string; limit?: number }) => ({ echoed: args.query, limit: args.limit }),
    presentCall: (args: { query: string }) => ({ type: "card", title: args.query }),
    presentResult: () => ({ type: "card", title: "done" }),
  });

  it("编译产物：name/description/parameters/output.schema/timeoutMs", () => {
    expect(tool.name).toBe("demo_tool");
    expect(tool.description).toBe("演示工具");
    expect(tool.parameters.required).toEqual(["query"]);
    // json 类型编译为无 type 的注记性节点（上游同款）
    expect(tool.output.schema).toEqual({});
    expect(tool.timeoutMs).toBe(1000);
  });

  it("execute：先校验后执行；违规抛 ToolArgsError（INVALID_ARGS，单行 message）", async () => {
    const failure = await tool.execute({ limit: 1 }, exec()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolArgsError);
    expect((failure as ToolArgsError).code).toBe("INVALID_ARGS");
    expect((failure as ToolArgsError).message).toBe('invalid arguments: missing required property "query"');
    expect((failure as ToolArgsError).violations).toEqual(['missing required property "query"']);
    await expect(tool.execute({ query: "q" }, exec())).resolves.toEqual({ echoed: "q", limit: undefined });
  });

  it("render / presentCall / presentResult 软回退", async () => {
    expect(tool.output.render({ query: "q" }, 1)).toEqual([{ type: "text", text: "q=1" }]);
    expect(tool.presentCall?.({ query: "q" })).toEqual({ type: "card", title: "q" });
    expect(tool.presentCall?.({ query: undefined } as never)).toBeUndefined();
    const result = { content: [{ type: "text", text: "x" }], isError: false };
    expect(tool.presentResult?.({ query: "q" }, result)).toEqual({ type: "card", title: "done" });
    expect(tool.presentResult?.({ limit: 1 } as never, result)).toBeUndefined();
  });

  it("isConcurrencySafe：参数失配回退 false", () => {
    expect(tool.isConcurrencySafe?.({ query: "ab" })).toBe(true);
    expect(tool.isConcurrencySafe?.({ query: "a" })).toBe(false);
    expect(tool.isConcurrencySafe?.({ limit: 1 } as never)).toBe(false);
  });

  it("展示回调抛错不外溢（展示层回放安全）", () => {
    const brittle = defineTool({
      name: "brittle",
      description: "",
      parameters: { a: { type: "string" } },
      output: { schema: { type: "json" }, render: () => [{ type: "text", text: "" }] },
      execute: async () => 1,
      presentCall: () => { throw new Error("boom"); },
    });
    expect(brittle.presentCall?.({ a: "x" })).toBeUndefined();
  });

  it("timeoutMs 非法值 fail loud；execute 缺失 fail loud", () => {
    expect(() => defineTool({
      name: "bad",
      description: "",
      parameters: {},
      output: { schema: { type: "json" }, render: () => [] },
      execute: async () => 1,
      timeoutMs: 0,
    })).toThrow(/timeoutMs/);
    expect(() => defineTool({
      name: "bad2",
      description: "",
      parameters: {},
      output: { schema: { type: "json" }, render: () => [] },
      execute: undefined as never,
    })).toThrow(/execute/);
  });

  it("presentationMeta 透传", () => {
    const withMeta = defineTool({
      name: "meta_tool",
      description: "",
      parameters: { id: { type: "string", required: true } },
      output: {
        schema: { type: "json" },
        render: () => [{ type: "text", text: "" }],
        presentationMeta: (args: { id: string }) => ({ id: args.id }),
      },
      execute: async () => 1,
    });
    expect(withMeta.output.presentationMeta?.({ id: "7" }, 1)).toEqual({ id: "7" });
  });
});
