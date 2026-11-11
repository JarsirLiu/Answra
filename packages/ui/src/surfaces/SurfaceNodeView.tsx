import type { SurfaceNode } from "@answra/shared";
import type { ReactNode } from "react";
import { SurfaceButton, type SurfaceButtonVariant } from "../components/controls/SurfaceButton";

interface SurfaceNodeViewProps {
  node: SurfaceNode;
  onAction: (actionId: string) => void;
}

/** 固定原语渲染器：只把合法 SurfaceNode 树映射成产品控件，不执行外部代码。 */
export function SurfaceNodeView({ node, onAction }: SurfaceNodeViewProps): ReactNode {
  switch (node.type) {
    case "stack":
      return (
        <div
          className={`surface-stack surface-stack--${node.direction}`}
          style={{ gap: node.gap ?? 8 }}
        >
          {node.children.map((child, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 声明式节点树没有稳定业务 id，位置即身份
            <SurfaceNodeView key={index} node={child} onAction={onAction} />
          ))}
        </div>
      );
    case "text":
      return <p className={`surface-text surface-text--${node.variant ?? "body"}`}>{node.text}</p>;
    case "button":
      return (
        <SurfaceButton
          className="surface-interactive"
          disabled={node.disabled}
          onClick={() => onAction(node.actionId)}
          variant={toButtonVariant(node.variant)}
        >
          {node.label}
        </SurfaceButton>
      );
    case "list":
      return (
        <ul className="surface-list">
          {node.items.map((item) => (
            <li
              className="surface-list-item"
              data-checked={item.checked ? "true" : undefined}
              key={item.text}
            >
              {item.text}
            </li>
          ))}
        </ul>
      );
    case "progress":
      return (
        <div className="surface-progress">
          <div
            aria-label={node.label ?? "进度"}
            aria-valuemax={1}
            aria-valuemin={0}
            aria-valuenow={node.value}
            className="surface-progress-track"
            role="progressbar"
          >
            <span
              className="surface-progress-fill"
              style={{ width: `${Math.round(node.value * 100)}%` }}
            />
          </div>
          {node.label ? <span className="surface-progress-label">{node.label}</span> : null}
        </div>
      );
    case "divider":
      return <hr className="surface-divider" />;
  }
}

function toButtonVariant(
  variant: Extract<SurfaceNode, { type: "button" }>["variant"],
): SurfaceButtonVariant {
  if (variant === "primary") return "primary";
  if (variant === "danger") return "danger";
  return "default";
}
