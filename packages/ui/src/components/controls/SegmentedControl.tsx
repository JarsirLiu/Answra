import "./SegmentedControl.css";

interface SegmentedControlProps<T extends string> {
  /** 无障碍名称（必填，供屏幕阅读器与测试定位）。 */
  ariaLabel: string;
  /** 可选项集合。 */
  options: ReadonlyArray<{ value: T; label: string }>;
  /** 当前值（受控）。 */
  value: T;
  /** 值变化回调。 */
  onChange: (value: T) => void;
}

/**
 * 统一分段选择控件：替代原生 <select>（原生下拉在透明玻璃上弹出系统
 * 白底菜单，深色模式下刺眼且无法令牌化）。视觉全部由设计令牌绘制。
 */
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div aria-label={ariaLabel} className="segmented" role="radiogroup">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            aria-checked={active}
            className={active ? "segmented-item is-active" : "segmented-item"}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
