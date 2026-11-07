/** Agent ID 的启动期静态注册表；拒绝重复注册和请求未注册能力。 */
import type { AgentId } from "./definition";

export class AgentRegistry {
  private readonly ids = new Set<AgentId>();

  register(id: AgentId): void {
    if (this.ids.has(id)) throw new Error(`Agent 已注册：${id}`);
    this.ids.add(id);
  }

  require(id: AgentId): void {
    if (!this.ids.has(id)) throw new Error(`Agent 未注册：${id}`);
  }
}
