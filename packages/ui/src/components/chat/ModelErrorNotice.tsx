import { AlertCircle } from "lucide-react";
import { ICON_SM } from "../../tokens";
import styles from "./ModelErrorNotice.module.css";

interface ModelErrorNoticeProps {
  /** 用户可见的失败文案（未登录时是统一的登录提示）。 */
  message: string;
  /**
   * 传了才渲染「去登录」按钮：仅当失败原因确定是「需要登录」时由调用方传入。
   * 按钮是用户主动的动作，失败本身不会自动拉起浏览器授权页。
   */
  onSignIn?: () => void;
}

/**
 * 模型调用失败的统一提示：图标 + 文案（+ 可选「去登录」）。
 * 对话面板正文、回复条、展开的对话浮层共用同一份，避免同一次失败出现两种长相。
 *
 * 同一个表面同时最多一处：本轮已有流式 error 活动项时，调用方不再渲染本组件。
 */
export function ModelErrorNotice({ message, onSignIn }: ModelErrorNoticeProps) {
  return (
    <div className={styles.notice} role="alert">
      <AlertCircle aria-hidden="true" size={ICON_SM} />
      <span className={styles.text}>{message}</span>
      {onSignIn ? (
        <button className={styles.action} onClick={onSignIn} type="button">
          去登录
        </button>
      ) : null}
    </div>
  );
}
