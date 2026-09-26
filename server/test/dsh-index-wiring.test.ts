/**
 * dsh 兼容模式的启动接线不变量（源码级守卫）：dsh 运行期必须晚于 authState 解析（否则端口拿到
 * undefined 令牌 / const TDZ 打崩启动），插件加载计划必须在真实启动路径下发；主服务不挂 dsh 端点。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const read = () => readFile(SOURCE, "utf8");

describe("dsh 兼容模式启动接线", () => {
  it("dsh 运行期构造与首次 sync 都排在 authState 解析之后", async () => {
    const source = await read();
    const authIndex = source.indexOf("const authState = resolvedAccessToken");
    expect(authIndex).toBeGreaterThan(-1);
    expect(source.indexOf("new DshCompatRuntime(")).toBeGreaterThan(authIndex);
    expect(source.indexOf("await dshCompat.sync();")).toBeGreaterThan(authIndex);
  });

  it("启动按模式开关下发插件计划，热切换分支同步跟随开关值", async () => {
    const source = await read();
    expect(source).toContain("await extensions.syncDsh(true)");
    expect(source).toContain('key === "dshCompatEnabled"');
    const listener = source.slice(source.indexOf("void extensions.syncDsh("));
    expect(listener.slice(0, 200)).toContain("settings.effective().dshCompat.enabled");
  });

  it("装配唯一入口：index 走 DshCompatRuntime，app.ts 不感知 dsh 端口内部", async () => {
    const source = await read();
    const app = await readFile(path.join(path.dirname(SOURCE), "app.ts"), "utf8");
    expect(source).toContain("DshCompatRuntime");
    expect(app).not.toContain("dsh/web-protocol");
  });

  it("启动期 sync 包在 try/catch 里（端口占用不阻断主服务启动，失败原因入 stderr）", async () => {
    const source = await read();
    const syncIndex = source.indexOf("await dshCompat.sync();");
    expect(syncIndex).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, syncIndex - 400), syncIndex).lastIndexOf("try {")).toBeGreaterThan(-1);
    const after = source.slice(syncIndex, syncIndex + 400);
    expect(after).toMatch(/}\s*catch\s*\(/);
    expect(after).toContain("owc 主服务继续启动");
  });

  it("关闭态语义只声明「独立端口不监听」与关闭窗口内的 503，index 不注册 dsh 路由", async () => {
    const source = await read();
    const runtimeSource = await readFile(fileURLToPath(new URL("../src/dsh/web-protocol/runtime.ts", import.meta.url)), "utf8");
    expect(runtimeSource).toContain("独立端口不监听");
    expect(runtimeSource).toContain("没有任何 dsh 端点");
    expect(source).not.toContain("remote.mux");
  });
});
