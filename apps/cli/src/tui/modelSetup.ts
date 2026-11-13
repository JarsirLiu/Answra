/** 模型配置引导的步骤定义与完成度投影；只描述进度，不读写 store 或终端。 */
export type TuiSetupStep = "base-url" | "api-key" | "model-id";

export type TuiSetupItemState = "done" | "current" | "pending";

export interface TuiSetupChecklistItem {
  readonly label: string;
  readonly state: TuiSetupItemState;
}

const SETUP_STEPS = ["Base URL", "API Key", "模型 ID"] as const;

const STEP_INDEX: Record<TuiSetupStep, number> = {
  "base-url": 0,
  "api-key": 1,
  "model-id": 2,
};

export function setupChecklist(step: TuiSetupStep | undefined): readonly TuiSetupChecklistItem[] {
  const current = step === undefined ? 0 : STEP_INDEX[step];
  return SETUP_STEPS.map((label, index) => ({
    label,
    state: index < current ? "done" : index === current ? "current" : "pending",
  }));
}
