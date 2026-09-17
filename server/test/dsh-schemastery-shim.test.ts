/** dsh 垫片单测 · schemastery 子集（M1） */
import { describe, expect, it } from "vitest";
import Schema, { UnsupportedSchemaError, ValidationError } from "../src/dsh/schemastery-shim.js";

function expectValidationError(run: () => unknown, fragment?: string) {
  try {
    run();
    expect.fail("expected ValidationError");
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    if (fragment !== undefined) expect(error.message).toContain(fragment);
    return error;
  }
  throw new Error("unreachable");
}

describe("schemastery-shim 标量类型", () => {
  it("string：类型校验 + pattern + 长度范围", () => {
    expect(Schema.string()("abc")).toBe("abc");
    expectValidationError(() => Schema.string()(1), "expected string but got 1");
    expect(Schema.string().pattern(/^a+$/)("aaa")).toBe("aaa");
    expectValidationError(() => Schema.string().pattern(/^a+$/)("bbb"), "expect string to match regexp");
    expect(Schema.string().max(3)("abc")).toBe("abc");
    expectValidationError(() => Schema.string().max(3)("abcd"), "string length <= 3");
  });

  it("number：min/max/step（含小数步进）", () => {
    expect(Schema.number().min(0).max(10)(5)).toBe(5);
    expectValidationError(() => Schema.number().max(10)(11), "number <= 10");
    expect(Schema.number().step(1)(3)).toBe(3);
    expectValidationError(() => Schema.number().step(1)(3.5), "multiple of 1");
    expect(Schema.number().step(0.1)(0.3)).toBe(0.3);
    expectValidationError(() => Schema.number().step(0.1)(0.35), "multiple of 0.1");
    expect(Schema.natural()(2)).toBe(2);
    expectValidationError(() => Schema.natural()(-1), "number >= 0");
    // 上游 schemastery 无 integer 构造器；整除性由 step 表达
    expectValidationError(() => Schema.number().step(1)(1.5), "multiple of 1");
  });

  it("boolean / const / any / never", () => {
    expect(Schema.boolean()(true)).toBe(true);
    expectValidationError(() => Schema.boolean()("yes"), "expected boolean but got yes");
    expect(Schema.const("a")("a")).toBe("a");
    expectValidationError(() => Schema.const("a")("b"), "expected a but got b");
    expect(Schema.const(1)(1)).toBe(1);
    expect(Schema.any()({ nested: [1, 2] })).toEqual({ nested: [1, 2] });
    expectValidationError(() => Schema.never()(1), "expected nullable but got 1");
  });

  it("function 类型", () => {
    const fn = () => 1;
    expect(Schema.function()(fn)).toBe(fn);
    expectValidationError(() => Schema.function()(1), "expected function but got 1");
  });
});

describe("schemastery-shim required/default 语义", () => {
  it("nullable + required 报错；否则取默认值", () => {
    expectValidationError(() => Schema.string().required()(undefined), "missing required value");
    expect(Schema.string().default("x")(undefined)).toBe("x");
    // 无默认值的 nullable 标量原样透传（上游语义）
    expect(Schema.string()(undefined)).toBeUndefined();
    expect(Schema.string()(null)).toBeNull();
  });

  it("默认值深拷贝：解析结果不污染 schema.meta.default", () => {
    const schema = Schema.object({ a: Schema.number().default(1) });
    const resolved = schema({});
    resolved.a = 99;
    expect(schema({}).a).toBe(1);
  });

  it("object：嵌套 required 路径前缀；缺席可选键不产出", () => {
    const schema = Schema.object({
      name: Schema.string().required(),
      age: Schema.number(),
      nested: Schema.object({ deep: Schema.string().required() }),
    });
    expectValidationError(
      () => schema({ name: "x", nested: {} }),
      // 上游语义：缺席必填键在 resolve 处报 missing required value，路径带前缀
      "$.nested.deep missing required value",
    );
    const resolved = schema({ name: "x", nested: { deep: "d" }, extra: 1 });
    expect(resolved).toEqual({ name: "x", nested: { deep: "d" }, extra: 1 });
    // extra 键保留（非 strict），缺席的可选键（age）不产出
    expect("age" in resolved).toBe(false);
  });

  it("object：整体缺失时用空默认值并填充内层默认", () => {
    const schema = Schema.object({ a: Schema.string().default("d") });
    expect(schema(undefined)).toEqual({ a: "d" });
  });
});

describe("schemastery-shim 组合类型", () => {
  it("union：首个成功分支；全败时错误含类型签名", () => {
    const schema = Schema.union([Schema.string(), Schema.number()]);
    expect(schema("s")).toBe("s");
    expect(schema(1)).toBe(1);
    expectValidationError(() => schema({}), "expected string | number but got {}");
  });

  it("intersect：对象按分支合并；类型冲突报错", () => {
    const schema = Schema.intersect([
      Schema.object({ a: Schema.string().default("a") }),
      Schema.object({ b: Schema.number().default(2) }),
    ]);
    expect(schema({})).toEqual({ a: "a", b: 2 });
    expect(schema({ a: "x" })).toEqual({ a: "x", b: 2 });
    const conflict = Schema.intersect([Schema.const(1), Schema.const(2)]);
    expectValidationError(() => conflict(1));
  });

  it("array：逐项解析 + 长度范围", () => {
    const schema = Schema.array(Schema.number().required());
    expect(schema([1, 2])).toEqual([1, 2]);
    expectValidationError(() => schema([1, "x"]), "[1] expected number but got x");
    expectValidationError(() => schema("x"), "expected array but got x");
    const bounded = Schema.array(Schema.number()).min(2);
    expectValidationError(() => bounded([1]), "array length >= 2");
  });

  it("dict：键值逐项解析", () => {
    const schema = Schema.dict(Schema.number());
    expect(schema({ a: 1 })).toEqual({ a: 1 });
    expectValidationError(() => schema({ a: "x" }), "$.a expected number but got x");
  });

  it("transform：strict 解析后应用回调", () => {
    const schema = Schema.transform(Schema.string(), value => (value as string).split(","));
    expect(schema("a,b")).toEqual(["a", "b"]);
    expectValidationError(() => schema(1), "expected string but got 1");
  });
});

describe("schemastery-shim 集成面", () => {
  it("~standard：cordis Config 校验入口（成功 / issues）", () => {
    const schema = Schema.object({ enabled: Schema.boolean().default(false), tag: Schema.string().required() });
    const standard = (schema as unknown as { "~standard": { validate: (v: unknown) => { value?: unknown; issues?: { message: string }[] } } })["~standard"];
    expect(standard.validate({ tag: "t" })).toEqual({ value: { enabled: false, tag: "t" } });
    const failed = standard.validate({});
    expect(failed.issues?.[0]?.message).toContain("$.tag");
  });

  it("可调用形式：schema(data) 直接解析", () => {
    const schema = Schema.number();
    expect(schema(5)).toBe(5);
    expectValidationError(() => (schema as unknown as (v: unknown) => unknown)("x"));
  });

  it("Schema.from：标量/Function 推断（上游同款 required）", () => {
    expect(Schema.from("x")("x")).toBe("x");
    expectValidationError(() => Schema.from("x")("y"), "expected x but got y");
    expect(Schema.from(String)("s")).toBe("s");
    const fn = () => 1;
    expect(Schema.from(Function)(fn)).toBe(fn);
    expectValidationError(() => Schema.from(Function)(1), "expected function but got 1");
  });

  it("未覆盖特性 fail loud（构造期抛 UnsupportedSchemaError）", () => {
    expect(() => Schema.date()).toThrow(UnsupportedSchemaError);
    expect(() => Schema.is(Date)).toThrow(UnsupportedSchemaError);
    expect(() => Schema.regExp()).toThrow(UnsupportedSchemaError);
    expect(() => Schema.arrayBuffer()).toThrow(UnsupportedSchemaError);
    expect(() => Schema.lazy(() => Schema.string())).toThrow(UnsupportedSchemaError);
    expect(() => Schema.from(Map)).toThrow(UnsupportedSchemaError);
    expect(() => (Schema.string() as unknown as { toJSON: () => void }).toJSON()).toThrow(UnsupportedSchemaError);
  });

  it("toString：union/object 签名（错误消息可读性）", () => {
    const schema = Schema.object({ a: Schema.string().required() });
    expect(schema.toString()).toBe("{ a: string }");
    expect(Schema.string().toString()).toBe("string");
    expect(Schema.array(Schema.boolean()).toString()).toBe("boolean[]");
  });
});
