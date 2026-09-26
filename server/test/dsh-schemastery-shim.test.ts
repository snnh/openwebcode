/** dsh 垫片单测 · schemastery 子集（M1）：对外可观测语义（校验/默认值/组合/集成面）。 */
import { describe, expect, it } from "vitest";
import Schema, { UnsupportedSchemaError, ValidationError } from "../src/dsh/schemastery-shim.js";

type AnySchema = (value: unknown) => unknown;
const parse = (schema: AnySchema, value: unknown) => schema(value);

/** 断言抛 ValidationError（可选断言消息片段）。 */
function rejects(run: () => unknown, fragment?: string): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    if (fragment !== undefined) expect(error.message).toContain(fragment);
    return;
  }
  throw new Error("expected ValidationError");
}

describe("schemastery-shim 校验语义", () => {
  it("标量：string（pattern/长度）、number（min/max/step）、natural、boolean/const/any/never/function", () => {
    expect(parse(Schema.string(), "abc")).toBe("abc");
    rejects(() => parse(Schema.string(), 1), "expected string but got 1");
    expect(parse(Schema.string().pattern(/^a+$/), "aaa")).toBe("aaa");
    rejects(() => parse(Schema.string().pattern(/^a+$/), "bbb"), "expect string to match regexp");
    rejects(() => parse(Schema.string().max(3), "abcd"), "string length <= 3");
    expect(parse(Schema.number().min(0).max(10), 5)).toBe(5);
    rejects(() => parse(Schema.number().max(10), 11), "number <= 10");
    expect(parse(Schema.number().step(0.1), 0.3)).toBe(0.3);
    rejects(() => parse(Schema.number().step(1), 3.5), "multiple of 1");
    rejects(() => parse(Schema.number().step(0.1), 0.35), "multiple of 0.1");
    rejects(() => parse(Schema.natural(), -1), "number >= 0");
    expect(parse(Schema.boolean(), true)).toBe(true);
    rejects(() => parse(Schema.boolean(), "yes"), "expected boolean but got yes");
    expect(parse(Schema.any(), { nested: [1, 2] })).toEqual({ nested: [1, 2] });
    rejects(() => parse(Schema.never(), 1), "expected nullable but got 1");
    const fn = () => 1;
    expect([parse(Schema.const("a"), "a"), parse(Schema.function(), fn)]).toEqual(["a", fn]);
    rejects(() => parse(Schema.const("a"), "b"), "expected a but got b");
    rejects(() => parse(Schema.function(), 1), "expected function but got 1");
  });

  it("required / default / object：必填缺失报错、默认值深拷贝、可选键不产出、extra 保留", () => {
    rejects(() => parse(Schema.string().required(), undefined), "missing required value");
    expect([parse(Schema.string().default("x"), undefined), parse(Schema.string(), undefined), parse(Schema.string(), null)])
      .toEqual(["x", undefined, null]);
    const dup = Schema.object({ a: Schema.number().default(1) });
    const resolved = dup({}) as { a: number };
    resolved.a = 99;
    expect((dup({}) as { a: number }).a).toBe(1);
    const schema = Schema.object({
      name: Schema.string().required(),
      age: Schema.number(),
      nested: Schema.object({ deep: Schema.string().required() }),
    });
    rejects(() => schema({ name: "x", nested: {} }), "$.nested.deep missing required value");
    const parsed = schema({ name: "x", nested: { deep: "d" }, extra: 1 }) as Record<string, unknown>;
    expect(parsed).toMatchObject({ name: "x", nested: { deep: "d" }, extra: 1 });
    expect("age" in parsed).toBe(false);
    expect(Schema.object({ a: Schema.string().default("d") })(undefined)).toEqual({ a: "d" });
  });

  it("组合类型：union 首个成功分支、intersect 合并/冲突、array/dict 逐项解析、transform 回调", () => {
    const union = Schema.union([Schema.string(), Schema.number()]);
    expect([union("s"), union(1)]).toEqual(["s", 1]);
    rejects(() => union({}), "expected string | number but got {}");
    const intersect = Schema.intersect([
      Schema.object({ a: Schema.string().default("a") }),
      Schema.object({ b: Schema.number().default(2) }),
    ]);
    expect([intersect({}), intersect({ a: "x" })]).toEqual([{ a: "a", b: 2 }, { a: "x", b: 2 }]);
    rejects(() => Schema.intersect([Schema.const(1), Schema.const(2)])(1));
    // array / dict / transform
    const array = Schema.array(Schema.number().required());
    expect(array([1, 2])).toEqual([1, 2]);
    rejects(() => array([1, "x"]), "[1] expected number but got x");
    rejects(() => array("x"), "expected array but got x");
    rejects(() => (Schema.array(Schema.number()).min(2) as AnySchema)([1]), "array length >= 2");
    const dict = Schema.dict(Schema.number());
    expect(dict({ a: 1 })).toEqual({ a: 1 });
    rejects(() => dict({ a: "x" }), "$.a expected number but got x");
    const transform = Schema.transform(Schema.string(), (value) => (value as string).split(","));
    expect(transform("a,b")).toEqual(["a", "b"]);
    rejects(() => (transform as unknown as AnySchema)(1), "expected string but got 1");
  });

  it("集成面：~standard/可调用/Schema.from/toString，未覆盖特性构造期 fail loud", () => {
    const schema = Schema.object({ enabled: Schema.boolean().default(false), tag: Schema.string().required() });
    const standard = (schema as unknown as { "~standard": { validate: (v: unknown) => { value?: unknown; issues?: { message: string }[] } } })["~standard"];
    expect(standard.validate({ tag: "t" })).toEqual({ value: { enabled: false, tag: "t" } });
    expect(standard.validate({}).issues?.[0]?.message).toContain("$.tag");
    expect(parse(Schema.number(), 5)).toBe(5);
    rejects(() => parse(Schema.number(), "x"));
    const fn = () => 1;
    expect([Schema.from("x")("x"), Schema.from(String)("s"), Schema.from(Function)(fn)]).toEqual(["x", "s", fn]);
    rejects(() => Schema.from("x")("y"), "expected x but got y");
    rejects(() => Schema.from(Function)(1), "expected function but got 1");
    expect([Schema.object({ a: Schema.string().required() }).toString(), Schema.string().toString(), Schema.array(Schema.boolean()).toString()]).toEqual(["{ a: string }", "string", "boolean[]"]);
    const unsupported: Array<() => unknown> = [
      () => Schema.date(),
      () => Schema.is(Date),
      () => Schema.regExp(),
      () => Schema.arrayBuffer(),
      () => Schema.lazy(() => Schema.string()),
      () => Schema.from(Map),
      () => (Schema.string() as unknown as { toJSON: () => void }).toJSON(),
    ];
    for (const build of unsupported) expect(build).toThrow(UnsupportedSchemaError);
  });
});
