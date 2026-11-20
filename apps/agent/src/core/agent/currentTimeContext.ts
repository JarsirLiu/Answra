/** 在 Agent 执行边界统一追加当前时间上下文；领域定义无需重复实现。 */
import { appendCurrentTimeContext } from "../context/currentTime";
import type { AgentDefinition } from "./definition";

export function withCurrentTimeContext<Input>(
  definition: AgentDefinition<Input>,
): AgentDefinition<Input> {
  if (definition.currentTimeContext === false) return definition;
  return {
    ...definition,
    async prepare(input, signal, emitter) {
      const prepared = await definition.prepare(input, signal, emitter);
      return { ...prepared, messages: appendCurrentTimeContext(prepared.messages) };
    },
  };
}
