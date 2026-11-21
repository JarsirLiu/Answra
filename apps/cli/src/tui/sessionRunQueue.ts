/** TUI 单会话运行队列：把提交 turn 映射到 host 队列，管理取消代际；不读写 Ink 或 view store。 */
import type { ConversationSendResult } from "@answra/shared";
import type { ImageAttachment } from "../image/attachment";
import type { CodingSession } from "../session/codingSession";
import type { TuiQueuedPrompt } from "./app/viewStore";

interface QueuedTurn {
  readonly id: string;
  readonly text: string;
  readonly images: readonly ImageAttachment[];
  readonly generation: number;
  started: boolean;
}

export interface SessionRunQueueOptions {
  readonly session: CodingSession;
  readonly onChange: () => void;
  readonly onFailure: (error: unknown) => void;
}

export class SessionRunQueue {
  private readonly session: CodingSession;
  private readonly onChange: () => void;
  private readonly onFailure: (error: unknown) => void;
  private readonly turns: QueuedTurn[] = [];
  private readonly sendingIds = new Set<string>();
  private inFlight = 0;
  private activeRunId?: string;
  private cancelling = false;
  private cancelVersion = 0;
  private sequence = 0;

  constructor({ session, onChange, onFailure }: SessionRunQueueOptions) {
    this.session = session;
    this.onChange = onChange;
    this.onFailure = onFailure;
  }

  get busy(): boolean {
    return this.inFlight > 0 || this.turns.length > 0;
  }

  get cancellingRun(): boolean {
    return this.cancelling;
  }

  get prompts(): readonly TuiQueuedPrompt[] {
    return this.turns.map((turn) => ({
      id: turn.id,
      text: turn.text,
      imageCount: turn.images.length,
      status: this.sendingIds.has(turn.id) ? "sending" : "queued",
    }));
  }

  submit(text: string, images: readonly ImageAttachment[] = []): void {
    if (text.trim().length === 0 && images.length === 0) return;
    this.turns.push({
      id: `queued-prompt-${++this.sequence}`,
      text,
      images,
      generation: this.cancelVersion,
      started: false,
    });
    this.notify();
    if (!this.cancelling) this.startQueued();
  }

  cancel(): boolean {
    if (!this.busy) return false;
    this.cancelVersion += 1;
    this.turns.length = 0;
    this.sendingIds.clear();
    this.cancelling = this.inFlight > 0;
    this.notify();
    if (this.activeRunId !== undefined) this.session.cancelRun(this.activeRunId);
    return true;
  }

  private notify(): void {
    this.onChange();
  }

  private startQueued(): void {
    if (this.cancelling) return;
    for (const turn of [...this.turns]) {
      if (turn.started) continue;
      turn.started = true;
      void this.runTurn(turn);
    }
  }

  private async runTurn(turn: QueuedTurn): Promise<void> {
    this.inFlight += 1;
    this.sendingIds.add(turn.id);
    this.notify();
    let runId: string | undefined;
    try {
      const accepted = await this.session.enqueue(turn.text, turn.images);
      this.sendingIds.delete(turn.id);
      this.notify();
      if (turn.generation !== this.cancelVersion) {
        await this.discardAccepted(accepted);
        return;
      }
      runId = accepted.status === "started" ? accepted.runId : await this.waitForStart(accepted);
      if (turn.generation !== this.cancelVersion) {
        if (runId !== undefined) this.session.cancelRun(runId);
        return;
      }
      this.removeTurn(turn);
      this.activeRunId = runId;
      this.notify();
      await this.session.wait(runId);
    } catch (error) {
      if (turn.generation === this.cancelVersion) {
        this.removeTurn(turn);
        this.onFailure(error);
      }
    } finally {
      this.inFlight -= 1;
      this.sendingIds.delete(turn.id);
      if (this.activeRunId === runId) this.activeRunId = undefined;
      if (this.cancelling && this.inFlight === 0) this.cancelling = false;
      this.notify();
      this.startQueued();
    }
  }

  private async waitForStart(accepted: Extract<ConversationSendResult, { status: "queued" }>) {
    const started = await this.session.waitForQueueStart(accepted.queueId);
    return started.runId;
  }

  private async discardAccepted(accepted: ConversationSendResult): Promise<void> {
    if (accepted.status === "started") {
      this.session.cancelRun(accepted.runId);
      return;
    }
    try {
      const started = await this.session.waitForQueueStart(accepted.queueId);
      this.session.cancelRun(started.runId);
    } catch {
      return;
    }
  }

  private removeTurn(turn: QueuedTurn): void {
    const index = this.turns.indexOf(turn);
    if (index >= 0) this.turns.splice(index, 1);
  }
}
