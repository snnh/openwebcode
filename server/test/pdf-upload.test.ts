import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient, FsWriteBase64Request } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

function workspacePath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

async function createApp(options: { agentRunning?: boolean } = {}): Promise<{
  root: string;
  sessions: SessionStore;
  app: Awaited<ReturnType<typeof buildServer>>;
  core: { configureSession: ReturnType<typeof vi.fn>; writeFileBase64: ReturnType<typeof vi.fn> };
}> {
  const root = await tempRoot("owc-pdf-upload-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const configureSession = vi.fn(async () => ({ sandboxCapability: "advisory" }));
  const writeFileBase64 = vi.fn(async (request: FsWriteBase64Request) => {
    const output = workspacePath(root, request.path);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(request.data, "base64"), { flag: "wx" });
    return { ok: true as const };
  });
  const core = { configureSession, writeFileBase64 };
  const app = await buildServer({
    core: core as unknown as CoreClient,
    sessions,
    agent: { isRunning: () => options.agentRunning === true } as AgentRunner,
    events: new EventBus(),
    providers: new ProviderRegistry(),
    pricing,
  });
  return { root, sessions, app, core };
}

function pdfData(contents = "%PDF-1.7\nminimal\n%%EOF\n"): string {
  return Buffer.from(contents).toString("base64");
}

describe("POST /api/sessions/:id/pdf-upload", () => {
  it("writes a Unicode PDF through core with a unique readable UUID filename", async () => {
    const { root, sessions, app, core } = await createApp();
    const session = await sessions.create({ cwd: root, provider: "test", model: "test" });
    const data = pdfData();
    try {
      const first = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/pdf-upload`, payload: { name: "合同.pdf", data } });
      expect(first.statusCode, first.body).toBe(201);
      const firstPath = first.json<{ path: string }>().path;
      expect(firstPath).toMatch(/^\.owc\/uploads\/合同-[0-9a-f-]{36}\.pdf$/);
      expect(await readFile(workspacePath(root, firstPath), "utf8")).toBe("%PDF-1.7\nminimal\n%%EOF\n");
      expect(core.configureSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, cwd: root }));
      expect(core.writeFileBase64).toHaveBeenCalledWith({ sessionId: session.id, path: firstPath, data, createDirs: true });

      const secondContents = "%PDF-1.7\nsecond copy\n%%EOF\n";
      const second = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/pdf-upload`, payload: { name: "合同.pdf", data: pdfData(secondContents) } });
      expect(second.statusCode, second.body).toBe(201);
      const secondPath = second.json<{ path: string }>().path;
      expect(secondPath).toMatch(/^\.owc\/uploads\/合同-[0-9a-f-]{36}\.pdf$/);
      expect(secondPath).not.toBe(firstPath);
      expect(await readFile(workspacePath(root, firstPath), "utf8")).toBe("%PDF-1.7\nminimal\n%%EOF\n");
      expect(await readFile(workspacePath(root, secondPath), "utf8")).toBe(secondContents);
      expect(core.configureSession).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("normalizes @ out of stored names and rejects names exceeding the UTF-8 byte limit", async () => {
    const { root, sessions, app } = await createApp();
    const session = await sessions.create({ cwd: root, provider: "test", model: "test" });
    try {
      const normalized = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/pdf-upload`,
        payload: { name: "report @README.md x.pdf", data: pdfData() },
      });
      expect(normalized.statusCode, normalized.body).toBe(201);
      expect(normalized.json<{ path: string }>().path).toMatch(/^\.owc\/uploads\/report _README\.md x-[0-9a-f-]{36}\.pdf$/);

      const tooManyUtf8Bytes = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/pdf-upload`,
        payload: { name: `${"合".repeat(80)}.pdf`, data: pdfData() },
      });
      expect(tooManyUtf8Bytes.statusCode, tooManyUtf8Bytes.body).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects uploads while the session agent is running", async () => {
    const { root, sessions, app, core } = await createApp({ agentRunning: true });
    const session = await sessions.create({ cwd: root, provider: "test", model: "test" });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/pdf-upload`,
        payload: { name: "report.pdf", data: pdfData() },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<{ error: string }>().error).toContain("running");
      await expect(readFile(path.join(root, ".owc", "uploads", "report.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(core.writeFileBase64).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects traversal names, malformed data, non-PDF bytes, and files over 20 MiB", async () => {
    const { root, sessions, app } = await createApp();
    const session = await sessions.create({ cwd: root, provider: "test", model: "test" });
    try {
      for (const body of [
        { name: "../escape.pdf", data: pdfData() },
        { name: "dir\\escape.pdf", data: pdfData() },
        { name: "report.pdf", data: "not base64!" },
        { name: "report.pdf", data: Buffer.from("not a PDF").toString("base64") },
      ]) {
        const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/pdf-upload`, payload: body });
        expect(response.statusCode, response.body).toBe(400);
      }

      const tooLarge = Buffer.alloc(20 * 1024 * 1024 + 1);
      tooLarge.write("%PDF-1.7");
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/pdf-upload`,
        payload: { name: "large.pdf", data: tooLarge.toString("base64") },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ error: string }>().error).toContain("20 MiB");
    } finally {
      await app.close();
    }
  }, 20_000);
});
