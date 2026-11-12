/** CLI 应用层依赖端口；main.ts 注入真实实现，测试注入 fake。 */
import type { AgentEventEnvelope } from "@answra/shared/schema";
import type { CodingSessionHost } from "../session/codingSession";
import type { InputPort } from "../transport/input";
import type { OutputPort } from "../transport/output";

export interface SessionHostOptions {
  emitEvent: (event: AgentEventEnvelope) => void;
  workspaceRoot: string;
}

export interface CliDependencies {
  env: Readonly<Record<string, string | undefined>>;
  input: InputPort;
  output: OutputPort;
  cwd: string;
  createSessionHost(options: SessionHostOptions): CodingSessionHost;
  createConversationId(): string;
  onInterrupt(handler: () => void): () => void;
}
