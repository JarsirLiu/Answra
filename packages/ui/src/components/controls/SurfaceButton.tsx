import type { ButtonHTMLAttributes } from "react";

import "./SurfaceButton.css";

export type SurfaceButtonVariant = "default" | "primary" | "quiet" | "danger";
export type SurfaceButtonSize = "xs" | "sm" | "md" | "lg";

export interface SurfaceButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: SurfaceButtonVariant;
  size?: SurfaceButtonSize;
}

/** 悬浮表面内的统一按钮基元；业务组件只选择语义变体和尺寸档，不自行拼按钮基础样式。 */
export function SurfaceButton({
  className,
  type = "button",
  variant = "default",
  size = "md",
  ...props
}: SurfaceButtonProps) {
  return (
    <button
      {...props}
      className={`surface-control surface-control--${variant} surface-control--${size}${className ? ` ${className}` : ""}`}
      type={type}
    />
  );
}
