import { useState } from "react";
import { AMBIENT_FOLLOW_STORAGE_KEY } from "../model";
import { loadAmbientFollow } from "../theme";

/** 变色龙开关只管理自身的本地偏好，不依赖平台能力或隐身状态。 */
export function useAmbientFollow() {
  const [enabled, setEnabled] = useState(loadAmbientFollow);

  function setEnabledPersisted(value: boolean) {
    console.info("[settings][ambient] toggle", { from: enabled, to: value });
    setEnabled(value);
    localStorage.setItem(AMBIENT_FOLLOW_STORAGE_KEY, value ? "on" : "off");
  }

  return [enabled, setEnabledPersisted] as const;
}
