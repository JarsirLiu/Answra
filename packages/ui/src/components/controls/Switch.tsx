import "./Switch.css";

interface SwitchProps {
  /** 无障碍名称（必填，供屏幕阅读器与测试定位）。 */
  ariaLabel: string;
  /** 当前状态（受控）。 */
  checked: boolean;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 状态变化回调。 */
  onChange: (checked: boolean) => void;
}

/**
 * 统一开关控件：真实 checkbox 承载语义（role/checked/disabled 与原生一致），
 * 视觉完全由设计令牌绘制——深浅色模式下轨道/拇指颜色随令牌自动翻转，
 * 不出现原生控件的黑底白块。
 */
export function Switch({ ariaLabel, checked, disabled = false, onChange }: SwitchProps) {
  const state = `${checked ? " is-on" : ""}${disabled ? " is-disabled" : ""}`;
  return (
    <span className={`switch${state}`}>
      <input
        aria-label={ariaLabel}
        checked={checked}
        className="switch-input"
        data-ime-policy="excluded"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span aria-hidden="true" className="switch-track">
        <span className="switch-thumb" />
      </span>
    </span>
  );
}
