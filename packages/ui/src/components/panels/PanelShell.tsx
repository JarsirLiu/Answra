import { X } from "lucide-react";
import type { ReactNode } from "react";
import { ICON_SM } from "../../tokens";
import "./PanelShell.css";

interface PanelShellProps {
  title: string;
  /** 面板变体，对应 PanelShell.css 的 content-panel--<variant> 尺寸分支。 */
  variant: "chat" | "notes" | "settings";
  /** 头部右侧的上下文提示（如“截图已添加”）。 */
  context?: string;
  /** 附加到 section 的自定义类名（如回复条 layout 约束）。 */
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

/** 内容面板通用外壳：头部（标题/上下文/关闭）+ 内容区。 */
export function PanelShell({
  title,
  variant,
  context,
  className,
  onClose,
  children,
}: PanelShellProps) {
  return (
    <section
      aria-label={title}
      className={`content-panel content-panel--${variant}${className ? ` ${className}` : ""}`}
    >
      <header className="panel-header">
        <h1 className="panel-title">{title}</h1>
        {context && <div className="panel-context">{context}</div>}
        <button aria-label="收起面板" className="panel-close" onClick={onClose} type="button">
          <X aria-hidden="true" size={ICON_SM} />
        </button>
      </header>
      {children}
    </section>
  );
}
