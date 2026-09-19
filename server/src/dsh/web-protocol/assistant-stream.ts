/**
 * dsh 助手流式增量（`assistant-stream` 帧）：把 owc 的 `message.delta` / `message.thinking_delta`
 * 投影成 dsh `session/follow` 流内的瞬态帧，供 dsh UI 在回合进行中逐字渲染。
 *
 * 形状与语义权威来源（vendor）：
 *   - 帧形状：`@deepseek-ai/dsh-api-remotes` 的 session/follow result union 成员
 *     `{type:'assistant-stream', frame:
 *        {type:'start', attemptId, revision, startedAfterSeq, turn, step}
 *      | {type:'chunk', attemptId, revision, index, time, chunk}
 *      | {type:'end', attemptId, revision, index, outcome:{kind:'committed', eventType:'assistant/message'|'assistant/attempt', seq}
 *                                                       | {kind:'abandoned'}}}`；
 *   - `revision` 是**帧序号**：客户端 `dsh-api-session-controller` 对每帧要求
 *     `frame.revision === 上一帧 + 1`（不连续直接抛 carrier error），首帧相对快照的
 *     `assistantStream.revision` 递增；
 *   - `index` 是**尝试内密排序号**：客户端要求 `frame.index === nextIndex`，否则要求 rebaseline；
 *   - `chunk` 是块级增量（`ui-chat` 的 `updateChunk`）：`{type:'block-start', index, blockType}` /
 *     `{type:'text-delta', index, text}` / `{type:'reasoning-delta', index, text}`；
 *   - `end` 的 `outcome.seq` 必须是那条**已下发的** `assistant/message` 记录的 seq：客户端在
 *     attempt 活跃期间会把该记录挂起（pending），只有 end 帧才会释放它——因此「开了 attempt
 *     就必须发 end」是本设计的一致性要求（否则回复会被挂住不显示）。
 *
 * 本模块只做纯投影（无 IO、无状态外泄），便于用 vendor codec 单测钉住形状。
 */

/** 一条待下发的帧（`session/follow` 流的 item 值）。 */
export interface DshAssistantStreamFrame {
  type: "assistant-stream";
  frame: Record<string, unknown>;
}

/** 快照里的 `assistantStream` 基线。 */
export interface DshAssistantStreamBaseline {
  revision: number;
}

/** 增量输入的类别（owc 事件 → 块类型）。 */
export type DshAssistantDeltaKind = "text" | "reasoning";

/**
 * 一次回合内的助手增量追踪器：每会话（每 follow 流）一个实例。
 *
 * 生命周期：首个增量到来时开启 attempt（start 帧）；此后每个增量产出若干 chunk 帧；
 * 助手消息落盘（durable 记录下发）时关闭 attempt（end 帧，outcome committed）；
 * 回合被中断时以 abandoned 关闭；`dispose()` 用于流取消（不发帧，客户端重连走快照）。
 */
export class DshAssistantStreamTracker {
  /** 帧序号（与快照 `assistantStream.revision` 同口径；每帧 +1）。 */
  private revision = 0;
  private attempt:
    | { id: string; turn: number; step: number; nextIndex: number; blockIndex: number; blockKind: DshAssistantDeltaKind | undefined }
    | undefined;

  constructor(private readonly newAttemptId: () => string) {}

  /** 快照基线（连接/重连时下发；v1 不带 activeAttempt——见类注释的降级说明）。 */
  baseline(): DshAssistantStreamBaseline {
    return { revision: this.revision };
  }

  /** 当前是否有活跃 attempt（测试与流实现共用）。 */
  get active(): boolean {
    return this.attempt !== undefined;
  }

  /**
   * 回合开始的锚点（`startedAfterSeq`）：客户端要求落盘的 assistant/message 记录 `seq > startedAfterSeq`
   * 才认这次 attempt 的结算，因此取「当前已下发游标」即可。
   */
  private start(turn: number, step: number, startedAfterSeq: number): DshAssistantStreamFrame {
    const attempt = { id: this.newAttemptId(), turn, step, nextIndex: 0, blockIndex: -1, blockKind: undefined };
    this.attempt = attempt;
    return {
      type: "assistant-stream",
      frame: { type: "start", attemptId: attempt.id, revision: ++this.revision, startedAfterSeq, turn, step },
    };
  }

  /**
   * 处理一个增量，返回要下发的帧序列。
   * @param startedAfterSeq 当前已下发游标（开启 attempt 时作为 `startedAfterSeq`）。
   * @param turnStep 本次回合的 turn/step（必须与随后 assistant/message 记录里的 `data.turn/step` 一致）。
   */
  onDelta(
    kind: DshAssistantDeltaKind,
    text: string,
    time: number,
    startedAfterSeq: number,
    turnStep: { turn: number; step: number },
  ): DshAssistantStreamFrame[] {
    if (text === "") return [];
    const frames: DshAssistantStreamFrame[] = [];
    if (this.attempt === undefined) frames.push(this.start(turnStep.turn, turnStep.step, startedAfterSeq));
    const attempt = this.attempt!;
    // 块切换（reasoning ↔ text）：先开出新块（块序号 = 内容块下标，按到达顺序）；
    // 工具调用增量不下发（v1：工具调用由落盘后的 assistant/message 承载），因此不会与块序号冲突。
    if (attempt.blockKind !== kind) {
      attempt.blockKind = kind;
      attempt.blockIndex += 1;
      frames.push(this.chunk({ type: "block-start", index: attempt.blockIndex, blockType: kind === "text" ? "text" : "reasoning" }, time));
    }
    frames.push(this.chunk(
      kind === "text"
        ? { type: "text-delta", index: attempt.blockIndex, text }
        : { type: "reasoning-delta", index: attempt.blockIndex, text },
      time,
    ));
    return frames;
  }

  private chunk(chunk: Record<string, unknown>, time: number): DshAssistantStreamFrame {
    const attempt = this.attempt!;
    const frame: DshAssistantStreamFrame = {
      type: "assistant-stream",
      frame: { type: "chunk", attemptId: attempt.id, revision: ++this.revision, index: attempt.nextIndex, time, chunk },
    };
    attempt.nextIndex += 1;
    return frame;
  }

  /**
   * 助手消息落盘（该记录已下发）：关闭 attempt 并返回 end 帧。
   * 没有活跃 attempt 时返回空数组（未流式过的回合无需结算帧）。
   */
  onSettled(seq: number): DshAssistantStreamFrame[] {
    const attempt = this.attempt;
    if (attempt === undefined) return [];
    this.attempt = undefined;
    return [{
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId: attempt.id,
        revision: ++this.revision,
        index: attempt.nextIndex,
        outcome: { kind: "committed", eventType: "assistant/message", seq },
      },
    }];
  }

  /** 回合被中断（abort/失败）：以 abandoned 关闭 attempt，让客户端丢弃瞬态内容。 */
  onAbandoned(): DshAssistantStreamFrame[] {
    const attempt = this.attempt;
    if (attempt === undefined) return [];
    this.attempt = undefined;
    return [{
      type: "assistant-stream",
      frame: { type: "end", attemptId: attempt.id, revision: ++this.revision, index: attempt.nextIndex, outcome: { kind: "abandoned" } },
    }];
  }
}
