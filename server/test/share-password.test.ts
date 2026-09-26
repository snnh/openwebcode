import { describe, expect, it } from "vitest";
import { hashSharePassword, verifySharePassword } from "../src/chat/share-password.js";

/** 分享口令为 scrypt 加盐派生：无盐 SHA-256 的历史哈希按「不匹配」处理（不做迁移）。 */
describe("chat 分享口令", () => {
  it("同一口令两次派生不同（有盐），但都能校验通过", async () => {
    const a = await hashSharePassword("hunter2");
    const b = await hashSharePassword("hunter2");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    await expect(verifySharePassword("hunter2", a)).resolves.toBe(true);
    await expect(verifySharePassword("hunter2", b)).resolves.toBe(true);
  });

  it("错误口令、旧格式哈希与畸形存储一律不匹配", async () => {
    const stored = await hashSharePassword("hunter2");
    for (const [password, value] of [
      ["hunter3", stored],
      ["hunter2", undefined],
      ["hunter2", ""],
      ["hunter2", "a".repeat(64)],                       // 历史无盐 sha256
      ["hunter2", "scrypt$$deadbeef"],                   // 缺盐
      ["hunter2", `scrypt$${stored.split("$")[2]}`],
    ] as Array<[string, string | undefined]>) {
      await expect(verifySharePassword(password, value)).resolves.toBe(false);
    }
  });
});
