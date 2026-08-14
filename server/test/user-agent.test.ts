import { afterEach, describe, expect, it } from "vitest";
import { buildUserAgent, getOfficialUserAgent, getUserAgent, setSimulatedUserAgent } from "../src/user-agent.js";
import { setServerVersion } from "../src/version.js";

afterEach(() => {
  // 恢复到一个稳定的已知状态，避免测试间相互污染
  setServerVersion("0.0.0");
  setSimulatedUserAgent(null);
});

describe("user-agent module", () => {
  it("builds UA in the owc/openwebcode{version} format", () => {
    expect(buildUserAgent("0.5.2")).toBe("owc/openwebcode0.5.2");
  });

  it("getUserAgent reflects the resolved server version by default", () => {
    setServerVersion("9.9.9");
    expect(getUserAgent()).toBe("owc/openwebcode9.9.9");
  });

  it("simulated UA overrides the default for getUserAgent", () => {
    setServerVersion("1.7.4");
    setSimulatedUserAgent("claude-code/2.1.232");
    expect(getUserAgent()).toBe("claude-code/2.1.232");
    // 清除覆盖后恢复官方默认
    setSimulatedUserAgent(null);
    expect(getUserAgent()).toBe("owc/openwebcode1.7.4");
  });

  it("getOfficialUserAgent stays official while simulation is active", () => {
    setServerVersion("1.7.4");
    setSimulatedUserAgent("codex/0.147.0");
    expect(getUserAgent()).toBe("codex/0.147.0");
    // 更新检查/更新应用链路：即使模拟生效也始终以官方身份访问
    expect(getOfficialUserAgent()).toBe("owc/openwebcode1.7.4");
  });
});
