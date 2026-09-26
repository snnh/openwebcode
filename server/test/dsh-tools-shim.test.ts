/** dsh 垫片单测 · dsh-tools 子集（M1）：defineTool 编译/校验/展示回退。 */
import { describe, expect, it } from "vitest";
import { ToolArgsError, defineTool, parameterSchemaSpecToJsonSchema, validateToolArgs, valueSchemaSpecToJsonSchema, type ParameterSchemaSpec } from "../src/dsh/dsh-tools-shim.js";

const noopSignal = new AbortController().signal;
const exec = () => ({ signal: noopSignal });

describe("dsh-tools-shim 参数编译", () => {
  it("隐式对象根：per-property required 收敛成 JSON Schema required 数组；嵌套 object/array/oneOf/json 逐层编译", () => {
    const schema = parameterSchemaSpecToJsonSchema({
      a: { type: "string", required: true, description: "A" },
      b: { type: "number" },
      nested: { type: "object", additionalProperties: false, properties: { list: { type: "array", items: { type: "integer" } }, choice: { oneOf: [{ type: "string" }, { type: "number" }] }, data: { type: "json", description: "any" } } },
    });
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["a"]);
    expect(schema.properties?.a).toEqual({ type: "string", description: "A" });
    expect(schema.properties?.b).toEqual({ type: "number" });
    const nested = schema.properties?.nested as { additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
    expect(nested.additionalProperties).toBe(false);
    expect(nested.properties.list?.items).toEqual({ type: "integer" });
    expect(nested.properties.choice?.oneOf).toHaveLength(2);
    expect(nested.properties.data).toEqual({ description: "any" }); // json 编译为无 type 的注记性节点（上游同款）
  });

  it("编译期 fail loud：object 必须显式声明 additionalProperties、循环引用、array 上的 enum/const、标量约束不匹配、作者侧未知键", () => {
    const circular: Record<string, unknown> = { name: { type: "string" } };
    circular.self = circular;
    const circularValue: Record<string, unknown> = { type: "object", additionalProperties: false };
    circularValue.properties = { inner: circularValue };
    const cases: Array<[string, () => unknown]> = [
      ["additionalProperties must be explicitly true or false", () => valueSchemaSpecToJsonSchema({ type: "object", properties: { text: { type: "string" } } } as never)],
      ["additionalProperties must be explicitly true or false", () => valueSchemaSpecToJsonSchema({ type: "object", additionalProperties: "no", properties: {} } as never)],
      ["parameters.self is circular", () => parameterSchemaSpecToJsonSchema(circular as never)],
      ["is circular", () => valueSchemaSpecToJsonSchema(circularValue as never)],
      ["schema DSL", () => parameterSchemaSpecToJsonSchema({ a: { type: "array", items: { type: "string" }, enum: [["x"]] } } as never)],
      ["const must be a string value", () => parameterSchemaSpecToJsonSchema({ a: { type: "string", const: 1 } } as never)],
      ["const must be one of", () => valueSchemaSpecToJsonSchema({ type: "object", additionalProperties: false, properties: { k: { type: "string", const: "b", enum: ["a"] } } } as never)],
      ["annotation must be lossless JSON data", () => valueSchemaSpecToJsonSchema({ type: "object", additionalProperties: false, properties: { k: { type: "string", default: new Date() } } } as never)],
      ["unknownKey", () => parameterSchemaSpecToJsonSchema({ a: { type: "string", unknownKey: 1 } as unknown as ParameterSchemaSpec })],
      ["required", () => parameterSchemaSpecToJsonSchema({ a: { type: "string", required: false } as unknown as ParameterSchemaSpec })],
      ["oneOf", () => valueSchemaSpecToJsonSchema({ oneOf: [{ type: "string" }] } as never)],
      ["must be string/number/integer/boolean/null/array/object/json, or use oneOf", () => valueSchemaSpecToJsonSchema({ type: "map" } as never)],
      ["cannot declare both type and oneOf", () => valueSchemaSpecToJsonSchema({ type: "string", oneOf: [{ type: "string" }, { type: "number" }] } as never)],
    ];
    for (const [fragment, run] of cases) expect(run, fragment).toThrow(new RegExp(fragment.replace(/[/.]/g, "\\$&")));
  });
});

describe("dsh-tools-shim 参数校验", () => {
  const schema = parameterSchemaSpecToJsonSchema({
    name: { type: "string", required: true }, level: { type: "integer", enum: [1, 2, 3] },
    tags: { type: "array", items: { type: "string" } }, meta: { type: "object", additionalProperties: false, properties: { deep: { type: "boolean" } } },
    any: { type: "json" },
  });

  it("合法参数零违规；类型/枚举/嵌套/额外键违规带引号路径（文案与上游逐字一致）", () => {
    expect(validateToolArgs(schema, { name: "x", level: 2, tags: ["a"], meta: { deep: true }, any: { k: [1] } })).toEqual([]);
    const text = validateToolArgs(schema, { level: 4, tags: ["a", 5], meta: { deep: "yes", extra: 1 } }).join("\n");
    for (const fragment of [
      'missing required property "name"', '"level" must be one of [1,2,3]', '"tags[1]" must be a string',
      '"meta.deep" must be a boolean', '"meta.extra" is not a declared property (additionalProperties: false)',
    ]) expect(text).toContain(fragment);
  });

  it("json 接受任意 lossless JSON（拒非 JSON 值）、integer 拒小数、根非对象用 arguments 路径、required 的显式 undefined 视同缺席", () => {
    expect(validateToolArgs(schema, { name: "x", any: [1, "a", null, { b: true }] })).toEqual([]);
    expect(validateToolArgs(schema, { name: "x", any: new Date() }).join("\n")).toContain('"any" must be a lossless JSON value');
    expect(validateToolArgs(schema, { name: "x", level: 1.5 }).join("\n")).toContain("must be an integer");
    expect(validateToolArgs(schema, "nope")).toEqual(['"arguments" must be an object']);
    expect(validateToolArgs(schema, { name: undefined })).toEqual(['missing required property "name"']);
  });

  it("oneOf 必须恰好命中一个分支：0 与 2 都拒（上游 matched 计数语义）", () => {
    const single = parameterSchemaSpecToJsonSchema({ v: { oneOf: [{ type: "string" }, { type: "number" }] } });
    expect([validateToolArgs(single, { v: "s" }), validateToolArgs(single, { v: 3 })]).toEqual([[], []]);
    expect(validateToolArgs(single, { v: true })).toEqual(['"v" must match exactly one oneOf branch (matched 0)']);
    const overlap = parameterSchemaSpecToJsonSchema({ v: { oneOf: [{ type: "string" }, { type: "string", enum: ["a"] }] } });
    expect(validateToolArgs(overlap, { v: "a" })).toEqual(['"v" must match exactly one oneOf branch (matched 2)']);
  });
});

describe("dsh-tools-shim defineTool 行为", () => {
  const tool = defineTool({
    name: "demo_tool", description: "演示工具",
    parameters: { query: { type: "string", required: true, description: "查询词" }, limit: { type: "number" } },
    output: {
      schema: { type: "json" },
      render: (args: { query: string }, value: unknown) => [{ type: "text", text: `${args.query}=${String(value)}` }],
      presentationMeta: (args: { query: string }) => ({ id: args.query }),
    },
    timeoutMs: 1000, isConcurrencySafe: (args: { query: string }) => args.query.length > 1,
    execute: async (args: { query: string; limit?: number }) => ({ echoed: args.query, limit: args.limit }),
    presentCall: (args: { query: string }) => ({ type: "card", title: args.query }),
    presentResult: () => ({ type: "card", title: "done" }),
  });

  it("编译产物：name/description/required/timeoutMs/presentationMeta 透传", async () => {
    expect([tool.name, tool.description, tool.parameters.required, tool.output.schema, tool.timeoutMs])
      .toEqual(["demo_tool", "演示工具", ["query"], {}, 1000]);
    expect(tool.output.presentationMeta?.({ query: "7" }, 1)).toEqual({ id: "7" });
    await expect(tool.execute({ query: "q" }, exec())).resolves.toEqual({ echoed: "q", limit: undefined });
  });

  it("execute 先校验后执行：违规抛 ToolArgsError（INVALID_ARGS，单行 message）", async () => {
    const failure = await tool.execute({ limit: 1 }, exec()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolArgsError);
    expect([(failure as ToolArgsError).code, (failure as ToolArgsError).message, (failure as ToolArgsError).violations])
      .toEqual(["INVALID_ARGS", 'invalid arguments: missing required property "query"', ['missing required property "query"']]);
  });

  it("展示层软回退：render/presentCall/presentResult/isConcurrencySafe 参数失配时回退，回调抛错不外溢", () => {
    expect(tool.output.render({ query: "q" }, 1)).toEqual([{ type: "text", text: "q=1" }]);
    expect([tool.presentCall?.({ query: "q" }), tool.presentCall?.({ query: undefined } as never)]).toEqual([{ type: "card", title: "q" }, undefined]);
    const result = { content: [{ type: "text", text: "x" }], isError: false };
    expect([tool.presentResult?.({ query: "q" }, result), tool.presentResult?.({ limit: 1 } as never, result)]).toEqual([{ type: "card", title: "done" }, undefined]);
    expect([tool.isConcurrencySafe?.({ query: "ab" }), tool.isConcurrencySafe?.({ query: "a" }), tool.isConcurrencySafe?.({ limit: 1 } as never)]).toEqual([true, false, false]);
    // 展示回调抛错不能让回放/渲染路径崩掉（展示层是尽力而为）
    const brittle = defineTool({
      name: "brittle", description: "", parameters: { a: { type: "string" } },
      output: { schema: { type: "json" }, render: () => [{ type: "text", text: "" }] }, execute: async () => 1,
      presentCall: () => { throw new Error("boom"); },
    });
    expect(brittle.presentCall?.({ a: "x" })).toBeUndefined();
  });

  it("作者侧声明非法 fail loud：timeoutMs 非法与 execute 缺失", () => {
    const base = { name: "bad", description: "", parameters: {}, output: { schema: { type: "json" }, render: () => [] }, execute: async () => 1 };
    expect(() => defineTool({ ...base, timeoutMs: 0 } as never)).toThrow(/timeoutMs/);
    expect(() => defineTool({ ...base, execute: undefined as never })).toThrow(/execute/);
  });
});
