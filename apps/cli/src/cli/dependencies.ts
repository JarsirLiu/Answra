/** CLI 应用层依赖端口；main.ts 注入真实实现，测试注入 fake。 */
import type { ModelCredentialStore } from "@answra/credentials";
import type { RemoteCredentialStore, RemoteHostKeyStore } from "@answra/remote";
import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import type { ModelSettings } from "../model/ports";
import type { CodingSessionHost } from "../session/codingSession";
import type { InputPort } from "../transport/input";
import type { OutputPort } from "../transport/output";
import type { TuiRunner } from "../tui/runTui";

export interface SessionHostOptions {
  emitEvent: (event: AgentEventEnvelope) => void;
  onSnapshot?: (snapshot: ConversationSnapshot) => void;
  workspaceRoot: string;
}

export interface RemoteKeyDependencies {
  hostKeys: RemoteHostKeyStore;
  credentials: RemoteCredentialStore;
  promptSecret(label: string): Promise<string>;
  now?(): Date;
}

export interface CliDependencies {
  env: Readonly<Record<string, string | undefined>>;
  input: InputPort;
  output: OutputPort;
  cwd: string;
  modelSettings: ModelSettings;
  modelCredentials: ModelCredentialStore;
  createSessionHost(options: SessionHostOptions): CodingSessionHost;
  createConversationId(): string;
  onInterrupt(handler: () => void): () => void;
  runTui: TuiRunner;
  remoteKeys?: RemoteKeyDependencies;
}
