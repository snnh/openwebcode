import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
afterEach(() => vi.unstubAllGlobals());
function stubJson(body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
describe("api 请求形状", () => {
  it("uploadPdf：裸 base64 提交到会话 pdf-upload 端点（路径转义）；sessionSandboxStatus：GET 会话 sandbox-status 端点", async () => {
    const upload = stubJson({ path: "uploads/report.pdf" }); const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "report.pdf", { type: "application/pdf" });
    await expect(api.uploadPdf("session id", file)).resolves.toEqual({ path: "uploads/report.pdf" });
    const [path, init] = (upload.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(path).toBe("/api/sessions/session%20id/pdf-upload");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init.body))).toEqual({ name: "report.pdf", data: "JVBERg==" });
    const status = stubJson({ sandboxCapability: "enforced", sandboxReason: "ok" });
    await expect(api.sessionSandboxStatus("session id")).resolves.toEqual({ sandboxCapability: "enforced", sandboxReason: "ok" });
    expect((status.mock.calls as unknown as Array<[string]>)[0]![0]).toBe("/api/sessions/session%20id/sandbox-status");
  });
});
