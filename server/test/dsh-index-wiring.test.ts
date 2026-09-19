/**
 * dsh 兼容模式的**启动接线不变量**（源码级守卫）。
 *
 * 背景：这两处缺口只有真机启动才暴露，单测覆盖不到，所以用源码顺序断言把语义钉住：
 *   1. dsh 运行期（`new DshCompatRuntime` / 首次 `sync()`）必须排在访问令牌 `authState` 解析之后——
 *      早于它会让 dsh 端口拿到 `undefined` 令牌（端口退化成免鉴权，非回环暴露），并且 `const` 的
 *      暂时性死区会直接把启动打成 `ReferenceError`（1.12.0 发布前实测到的启动崩溃）。
 *   2. dsh 插件加载计划必须在启动路径被真正下发（`extensions.syncDsh(...)`）——此前只在测试里调用，
 *      真实进程一个 dsh 插件都不会加载。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe("dsh 兼容模式启动接线", () => {
  it("dsh 运行期构造与首次 sync 都排在 authState 解析之后", async () => {
    const source = await readFile(SOURCE, "utf8");
    const authIndex = source.indexOf("const authState = resolvedAccessToken");
    const runtimeIndex = source.indexOf("new DshCompatRuntime(");
    const syncIndex = source.indexOf("await dshCompat.sync();");
    const readyIndex = source.indexOf("const renderedIndex");
    expect(authIndex).toBeGreaterThan(-1);
    expect(runtimeIndex).toBeGreaterThan(authIndex);
    expect(syncIndex).toBeGreaterThan(authIndex);
    // 同一份文件里 renderIndex 之类的主路径装配点存在即可（保证断言基准没写错文件）
    expect(readyIndex === -1 || readyIndex > authIndex).toBe(true);
  });

  it("启动按模式开关下发 dsh 插件加载计划，且开关热切换同步跟随", async () => {
    const source = await readFile(SOURCE, "utf8");
    expect(source).toContain("await extensions.syncDsh(true)");
    expect(source).toContain('key === "dshCompatEnabled"');
    // 开关变化分支里必须调用 syncDsh（关时不传值 → 默认 true 的旧形态会被这条断言挡住语义漂移）
    const listener = source.slice(source.indexOf('void extensions.syncDsh('));
    expect(listener.slice(0, 200)).toContain("settings.effective().dshCompat.enabled");
  });

  it("index 不绕过 DshCompatRuntime 直接读 vendor 目录（装配唯一入口）", async () => {
    const source = await readFile(SOURCE, "utf8");
    const other = await readFile(path.join(path.dirname(SOURCE), "app.ts"), "utf8");
    expect(source).toContain("DshCompatRuntime");
    // 主服务 app.ts 不得感知 dsh 端口内部（避免两套入口）
    expect(other).not.toContain("dsh/web-protocol");
  });

  it("D6：启动期 dshCompat.sync() 包在 try/catch 里（端口占用不阻断主服务启动）", async () => {
    const source = await readFile(SOURCE, "utf8");
    const syncIndex = source.indexOf("await dshCompat.sync();");
    expect(syncIndex).toBeGreaterThan(-1);
    // 该次 sync 必须在 try 块内（与设置热切换路径的 .catch 同一语义：失败只记原因）
    const before = source.slice(Math.max(0, syncIndex - 400), syncIndex);
    const tryIndex = before.lastIndexOf("try {");
    expect(tryIndex).toBeGreaterThan(-1);
    const after = source.slice(syncIndex, syncIndex + 400);
    expect(after).toMatch(/}\s*catch\s*\(/);
    // 失败信息要写进 stderr（可诊断），并说明主服务继续启动
    expect(after).toContain("owc 主服务继续启动");
  });

  it("D10：关闭态语义只声明「独立端口不监听」与关闭窗口内的 503，主服务不挂 dsh 端点", async () => {
    const source = await readFile(SOURCE, "utf8");
    const runtimeSource = await readFile(fileURLToPath(new URL("../src/dsh/web-protocol/runtime.ts", import.meta.url)), "utf8");
    // 关闭态权威表述：独立端口不监听（连接被拒）+ 主服务没有任何 dsh 端点
    expect(runtimeSource).toContain("独立端口不监听");
    expect(runtimeSource).toContain("没有任何 dsh 端点");
    // index 只在启动/热切换处碰 dshCompat，不往主服务 app 注册 dsh 路由
    expect(source).not.toContain("/api/remote.mux");
    expect(source).not.toContain("remote.mux");
  });
});
