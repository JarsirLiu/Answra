import type { ButtonHTMLAttributes } from "react";

import "./SurfaceButton.css";

export type SurfaceButtonVariant = "default" | "primary" | "quiet";

export interface SurfaceButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: SurfaceButtonVariant;
}

/** 悬浮表面内的统一按钮基元；业务组件只选择语义变体，不自行拼按钮基础样式。 */
export function SurfaceButton({
  className,
  type = "button",
  variant = "default",
  ...props
}: SurfaceButtonProps) {
  return (
    <button
      {...props}
      className={`surface-control surface-control--${variant}${className ? ` ${className}` : ""}`}
      type={type}
    />
  );
}
