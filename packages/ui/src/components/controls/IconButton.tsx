import type { LucideIcon, LucideProps } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

import { ICON, ICON_LG, ICON_SM, ICON_STROKE } from "../../tokens";
import { SurfaceButton, type SurfaceButtonSize, type SurfaceButtonVariant } from "./SurfaceButton";

const ICON_BY_SIZE: Record<SurfaceButtonSize, number> = {
  xs: ICON_SM,
  sm: ICON_SM,
  md: ICON,
  lg: ICON_LG,
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: LucideIcon;
  /** 必填：既作为可访问名称，也强制调用方说明图标意图。 */
  label: string;
  variant?: SurfaceButtonVariant;
  size?: SurfaceButtonSize;
  /** 个别图标需要额外 SVG 属性（如停止键的实心填充），尺寸与描边仍由令牌控制。 */
  iconProps?: Omit<LucideProps, "size" | "strokeWidth">;
}

/** 图标按钮原语：方形命中区，禁止文字混入；图标尺寸跟随 size 档。 */
export function IconButton({
  icon: Icon,
  label,
  variant = "default",
  size = "md",
  iconProps,
  className,
  ...props
}: IconButtonProps) {
  return (
    <SurfaceButton
      {...props}
      aria-label={label}
      className={`surface-control--icon${className ? ` ${className}` : ""}`}
      size={size}
      variant={variant}
    >
      <Icon aria-hidden="true" size={ICON_BY_SIZE[size]} strokeWidth={ICON_STROKE} {...iconProps} />
    </SurfaceButton>
  );
}
