/** Screenshot Answer Agent 定义：固定答题策略并只使用本次输入，不读取 transcript 历史。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { AgentDefinition } from "../core/agent/definition";
import { agentId } from "../core/agent/definition";
import { parseDataUrl } from "../core/model/imageInput";

const ANSWER_SYSTEM_PROMPT = [
  "你是 Answra 答题助手。先快速看懂题目，内部推理从简，直接作答，不反复验算、不比较多个方案；最终回复只给答案，不写分析过程，也不复述题目。",
  "",
  "只回答题干完整、清晰可辨的题；被截断、严重模糊的题，以及水印、页眉页脚等无关文字，一律忽略，不提及、不编号。",
  "",
  "输出规则：",
  "- 整条回复必须以「答案：」开头。",
  "- 只有一道题：只写一行「答案：<答案>」。",
  "- 有多道题：每题一行，格式为「答案：<答案>（<题号>）」；题号用试卷上印的，没有题号时用题干前 10 个字代替。",
  "- 选择题写选项字母和选项内容；判断题写「正确」或「错误」；填空题只写空内内容；计算题、编程题只写最终结果，题目明确要求过程时最多写 3 条关键步骤。",
  "- 题目要求说明理由时，最多补一句；能直接确定答案就不要解释。",
  "- 没有任何完整可作答的题时，才回复「未识别到题目」。",
  "",
  "禁止复述题目、寒暄、总结、多段展开；禁止在答案中使用 Markdown 标题、加粗或列表。",
].join("\n");

/** 独立注册的答题 Agent；输入只转成当前模型请求，不读取历史或授权工具。 */
export const screenshotAnswerAgent: AgentDefinition<ConversationSendRequest> = {
  id: agentId("answer.screenshot"),
  identity: {
    name: "答题助手",
    role: "answer",
    responsibility: "根据截图或题目文本给出一次性答案。",
    owns: ["screenshot-answer"],
  },
  discovery: { visibleTo: { kind: "bots", agentIds: [] } },
  modelRoute: "answer",
  async prepare(request) {
    const content = [
      ...(request.text.trim() ? [{ type: "text" as const, text: request.text }] : []),
      ...request.images.map((image) => {
        const parsed = parseDataUrl(image.dataUrl);
        return { type: "image" as const, image: parsed.bytes, mediaType: parsed.mediaType };
      }),
    ];
    return {
      system: ANSWER_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      temperature: 0.3,
      providerOptions: { openaiCompatible: { reasoningEffort: "low" } },
    };
  },
};
