/** Step 前上下文准备端口：由 StepRunner 调用，只返回最终模型请求，不读写 Turn 状态。 */
import type { AgentModelRequest } from "../agent/definition";
import type { ContextPreparation } from "./preparation";

export interface StepContextRequest {
  conversationId: string;
  getAccessToken: () => Promise<string>;
  modelRequest: AgentModelRequest;
  rebuild: () => Promise<AgentModelRequest>;
  signal: AbortSignal;
  onStatus?: () => void | Promise<void>;
}

export interface StepContextManager {
  prepare(input: StepContextRequest): Promise<AgentModelRequest>;
  recover(input: StepContextRequest): Promise<AgentModelRequest | undefined>;
}

/** 现有 ContextPreparation 的 Step 端口适配；模型请求仍由领域适配器构造。 */
export class PreparationStepContextManager implements StepContextManager {
  constructor(private readonly preparation: ContextPreparation) {}

  prepare(input: StepContextRequest): Promise<AgentModelRequest> {
    return this.preparation.prepareRequest(input);
  }

  recover(input: StepContextRequest): Promise<AgentModelRequest | undefined> {
    return this.preparation.recoverRequest(input);
  }
}
