import { describe, expect, it, vi } from "vitest";
import { sessionEnvActivationCommand, wrapCommandWithSessionEnv } from "../src/agent/session-env.js";
import type { SessionMeta } from "../src/sessions/types.js";
import { makeControllableCore } from "./helpers/fake-core.js";
import { makeAgentHarness } from "./helpers/agent-harness.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

function meta(overrides: Partial<SessionMeta> = {}): Pick<SessionMeta, "id" | "cwd" | "sandboxMode" | "agentMode"> {
  return { id: "s1", cwd: "/repo", ...overrides };
}

describe("sessionEnvActivationCommand（三语法族）", () => {
  it("sh（POSIX）：单条 export 多赋值，缺省 sandboxMode=jobobject / agentMode=code", () => {
    expect(sessionEnvActivationCommand(meta(), "sh", "linux")).toBe(
      "export OWC_SESSION_ID='s1' OWC_WORKSPACE='/repo' OWC_SANDBOX_MODE='jobobject' OWC_AGENT_MODE='code'",
    );
  });

  it("sh（win32 Git Bash）：路径反斜杠换正斜杠", () => {
    expect(sessionEnvActivationCommand(meta({ cwd: "C:\\repo" }), "sh", "win32")).toBe(
      "export OWC_SESSION_ID='s1' OWC_WORKSPACE='C:/repo' OWC_SANDBOX_MODE='jobobject' OWC_AGENT_MODE='code'",
    );
  });

  it("pwsh：$env:VAR = '...' 分号串联", () => {
    expect(sessionEnvActivationCommand(meta({ cwd: "C:\\repo" }), "pwsh", "win32")).toBe(
      "$env:OWC_SESSION_ID = 's1'; $env:OWC_WORKSPACE = 'C:\\repo'; $env:OWC_SANDBOX_MODE = 'jobobject'; $env:OWC_AGENT_MODE = 'code'",
    );
  });

  it("cmd：set \"VAR=...\" & 串联", () => {
    expect(sessionEnvActivationCommand(meta({ cwd: "C:\\repo" }), "cmd", "win32")).toBe(
      'set "OWC_SESSION_ID=s1" & set "OWC_WORKSPACE=C:\\repo" & set "OWC_SANDBOX_MODE=jobobject" & set "OWC_AGENT_MODE=code"',
    );
  });

  it("显式 sandboxMode/agentMode 覆盖缺省值", () => {
    expect(sessionEnvActivationCommand(meta({ sandboxMode: "appcontainer", agentMode: "plan" }), "sh", "linux")).toBe(
      "export OWC_SESSION_ID='s1' OWC_WORKSPACE='/repo' OWC_SANDBOX_MODE='appcontainer' OWC_AGENT_MODE='plan'",
    );
  });

  it("cwd 含空格/单引号：pwsh 双单引号、sh '\\'' 转义", () => {
    const tricky = meta({ cwd: "/tmp/O'Brien project" });
    expect(sessionEnvActivationCommand(tricky, "pwsh", "linux")).toContain("$env:OWC_WORKSPACE = '/tmp/O''Brien project'");
    expect(sessionEnvActivationCommand(tricky, "sh", "linux")).toContain(`OWC_WORKSPACE='/tmp/O'\\''Brien project'`);
    // cmd：set "VAR=..." 引号包裹，空格/单引号原样字面
    expect(sessionEnvActivationCommand(meta({ cwd: "C:\\O'Brien project" }), "cmd", "win32")).toContain(`set "OWC_WORKSPACE=C:\\O'Brien project"`);
  });
});

describe("wrapCommandWithSessionEnv（一次性 exec 最内层包装）", () => {
  it("sh/pwsh 用 `; ` 串联，cmd 用 ` && ` 串联", () => {
    expect(wrapCommandWithSessionEnv("echo hi", meta(), "sh", "linux")).toBe(
      "export OWC_SESSION_ID='s1' OWC_WORKSPACE='/repo' OWC_SANDBOX_MODE='jobobject' OWC_AGENT_MODE='code'; echo hi",
    );
    expect(wrapCommandWithSessionEnv("echo hi", meta(), "pwsh", "win32")).toContain("; echo hi");
    expect(wrapCommandWithSessionEnv("echo hi", meta({ cwd: "C:\\repo" }), "cmd", "win32")).toBe(
      'set "OWC_SESSION_ID=s1" & set "OWC_WORKSPACE=C:\\repo" & set "OWC_SANDBOX_MODE=jobobject" & set "OWC_AGENT_MODE=code" && echo hi',
    );
  });
});

describe("bash 工具一次性 exec 回退路径（fake core 无 pty/jobControl）", () => {
  async function runBashTool(sessionConfig?: Record<string, unknown>) {
    const core = makeControllableCore();
    const harness = await makeAgentHarness({
      // 无自定义 handler 的 stub provider：defaultEcho 解析 "run: <cmd>" 发 bash 工具调用
      provider: makeStubProvider("test-stub"),
      core: core.client,
      permissionMode: "yolo",
      tempPrefix: "owc-session-env-",
      ...(sessionConfig ? { sessionConfig } : {}),
    });
    try {
      const run = harness.agent.run(harness.session.id, "run: echo hi");
      await vi.waitFor(() => expect(core.runCalls.length).toBe(1), { timeout: 10_000 });
      const cmd = core.runCalls[0]!.cmd;
      core.release({ exitCode: 0, durationMs: 1, truncated: false });
      await run;
      return { cmd, sessionId: harness.session.id, cwd: harness.session.cwd };
    } finally {
      await harness.app.close();
    }
  }

  it("最终 cmd：会话环境变量 export 在用户命令之前生效", async () => {
    const { cmd, sessionId, cwd } = await runBashTool();
    expect(cmd).toContain("OWC_SESSION_ID");
    expect(cmd).toContain(sessionId);
    expect(cmd).toContain("OWC_WORKSPACE");
    expect(cmd).toContain("OWC_SANDBOX_MODE");
    expect(cmd).toContain("OWC_AGENT_MODE");
    // 会话 cwd 含空格/反斜杠（Windows 临时目录）时也必须出现在激活片段中
    expect(cmd.replace(/\\/g, "/")).toContain(cwd.replace(/\\/g, "/"));
    expect(cmd.indexOf("OWC_SESSION_ID")).toBeLessThan(cmd.indexOf("echo hi"));
  }, 20_000);

  it("组合顺序：node 环境包装在最外层，会话环境 export 在其内侧、用户命令之前", async () => {
    const { cmd } = await runBashTool({ nodeEnv: "project" });
    // wrapForSessionEnv 先拼（最内层），wrapForNodeEnv 后包（最外层）
    expect(cmd.indexOf("node_modules")).toBeLessThan(cmd.indexOf("OWC_SESSION_ID"));
    expect(cmd.indexOf("OWC_SESSION_ID")).toBeLessThan(cmd.indexOf("echo hi"));
  }, 20_000);
});
