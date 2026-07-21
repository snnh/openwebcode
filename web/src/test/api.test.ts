import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.uploadPdf", () => {
  it("sends a bare base64 PDF payload to the session upload endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: "uploads/report.pdf" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "report.pdf", { type: "application/pdf" });

    await expect(api.uploadPdf("session id", file)).resolves.toEqual({ path: "uploads/report.pdf" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>)[0]!;
    expect(path).toBe("/api/sessions/session%20id/pdf-upload");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({ name: "report.pdf", data: "JVBERg==" });
  });
});
