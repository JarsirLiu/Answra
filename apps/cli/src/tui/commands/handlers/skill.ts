/** skill 类命令：只打开只读目录面板，不加载或执行 skill。 */
import type { TuiCommandDeps } from "../ports";

const SKILL_NOTICE_KEY = "skills";

export function handleSkills(args: readonly string[], deps: TuiCommandDeps): void {
  if (args.length > 0) {
    deps.store.notify({
      key: SKILL_NOTICE_KEY,
      text: "/skills 不接受参数。",
      tone: "warning",
    });
    return;
  }
  if (deps.getSession() === undefined) throw new Error("尚未配置模型。");
  deps.openPanel("skills");
}
