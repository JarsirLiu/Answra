import type { CSSProperties } from "react";
import "./RangeSlider.css";

interface RangeSliderProps {
  /** 无障碍名称（必填，供屏幕阅读器与测试定位）。 */
  ariaLabel: string;
  /** 当前值（受控）。 */
  value: number;
  /** 最小值。 */
  min: number;
  /** 最大值。 */
  max: number;
  /** 步进。 */
  step?: number;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 值变化回调。 */
  onChange: (value: number) => void;
}

/**
 * 专用滑块控件：可见轨道 + 品牌色拇指，命中区域较大、在任何背景下均可拖拽。
 * 不包裹在 <label> 内，避免 label 的点击激活转发干扰拖拽手势。
 */
export function RangeSlider({
  ariaLabel,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange,
}: RangeSliderProps) {
  // 进度填充比例，供轨道渐变着色（已选区间显示品牌绿）
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      aria-label={ariaLabel}
      className="range-slider"
      data-ime-policy="excluded"
      disabled={disabled}
      max={max}
      min={min}
      onChange={(event) => onChange(Number(event.target.value))}
      step={step}
      style={{ ["--slider-fill" as string]: `${fill}%` } as CSSProperties}
      type="range"
      value={value}
    />
  );
}
