import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeUtf8Atomically } from "../atomic-file.js";
import { ensureDirWithMode } from "../fs-utils.js";
import type { ChatConfig } from "./chat-types.js";

/** 聊天模式全局配置服务（<dataDir>/chat.json），缺失/损坏时回落空配置。 */
export class ChatConfigService {
  constructor(private filePath: string) {}

  async get(): Promise<ChatConfig> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      return raw as ChatConfig;
    } catch {
      return {};
    }
  }

  async save(config: ChatConfig): Promise<void> {
    await ensureDirWithMode(path.dirname(this.filePath), 0o700);
    await writeUtf8Atomically(this.filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
}
