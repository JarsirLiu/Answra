import type {
  DesktopBridge,
  InterviewOnboardingPatch,
  InterviewOnboardingState,
  InterviewProjectAddRequest,
  InterviewResumeImportRequest,
} from "@answra/shared";
import { useCallback, useEffect, useState } from "react";

export interface InterviewOnboardingHandle {
  state: InterviewOnboardingState | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => Promise<void>;
  pickResume: () => Promise<boolean>;
  importResume: (request: InterviewResumeImportRequest) => Promise<void>;
  update: (patch: InterviewOnboardingPatch) => Promise<void>;
  addProject: (request: InterviewProjectAddRequest) => Promise<void>;
  complete: () => Promise<void>;
  skip: () => Promise<void>;
}

/** 面试引导的唯一 renderer 状态入口；所有写操作都以主进程返回的快照为准。 */
export function useInterviewOnboarding(
  platform: DesktopBridge | undefined,
): InterviewOnboardingHandle {
  const supported = Boolean(platform?.getInterviewOnboardingState);
  const [state, setState] = useState<InterviewOnboardingState>();
  const [loading, setLoading] = useState(supported);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    if (!platform?.getInterviewOnboardingState) return;
    setLoading(true);
    setError(undefined);
    try {
      setState(await platform.getInterviewOnboardingState());
    } catch (loadError) {
      setError(toMessage(loadError, "读取面试引导失败"));
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pickResume = useCallback(async (): Promise<boolean> => {
    setError(undefined);
    if (!platform?.pickInterviewResume) throw new Error("当前版本不支持选择简历");
    try {
      const result = await platform.pickInterviewResume();
      setState(result.state);
      return result.cancelled;
    } catch (pickError) {
      setError(toMessage(pickError, "读取简历失败"));
      throw pickError;
    }
  }, [platform]);

  const importResume = useCallback(
    async (request: InterviewResumeImportRequest): Promise<void> => {
      setError(undefined);
      if (!platform?.importInterviewResume) throw new Error("当前版本不支持导入简历");
      try {
        setState(await platform.importInterviewResume(request));
      } catch (importError) {
        setError(toMessage(importError, "导入简历失败"));
        throw importError;
      }
    },
    [platform],
  );

  const update = useCallback(
    async (patch: InterviewOnboardingPatch): Promise<void> => {
      setError(undefined);
      if (!platform?.updateInterviewOnboarding) throw new Error("当前版本不支持保存面试引导");
      try {
        setState(await platform.updateInterviewOnboarding(patch));
      } catch (updateError) {
        setError(toMessage(updateError, "保存面试引导失败"));
        throw updateError;
      }
    },
    [platform],
  );

  const addProject = useCallback(
    async (request: InterviewProjectAddRequest): Promise<void> => {
      setError(undefined);
      if (!platform?.addInterviewOnboardingProject) throw new Error("当前版本不支持添加项目");
      try {
        setState(await platform.addInterviewOnboardingProject(request));
      } catch (addError) {
        setError(toMessage(addError, "添加项目失败"));
        throw addError;
      }
    },
    [platform],
  );

  const complete = useCallback(async (): Promise<void> => {
    setError(undefined);
    if (!platform?.completeInterviewOnboarding) throw new Error("当前版本不支持完成引导");
    try {
      setState(await platform.completeInterviewOnboarding());
    } catch (completeError) {
      setError(toMessage(completeError, "完成引导失败"));
      throw completeError;
    }
  }, [platform]);

  const skip = useCallback(async (): Promise<void> => {
    setError(undefined);
    if (!platform?.skipInterviewOnboarding) throw new Error("当前版本不支持跳过引导");
    try {
      setState(await platform.skipInterviewOnboarding());
    } catch (skipError) {
      setError(toMessage(skipError, "跳过引导失败"));
      throw skipError;
    }
  }, [platform]);

  return {
    state,
    loading,
    error,
    reload,
    pickResume,
    importResume,
    update,
    addProject,
    complete,
    skip,
  };
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
