import { Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { ICON_SM } from "../../tokens";

interface PanelShellProps {
  title: string;
  modeLabel: string;
  /** 头部右侧的上下文提示（如“截图已添加”）。 */
  context?: string;
  onClose: () => void;
  children: ReactNode;
}

/** 内容面板通用外壳：头部（标题/上下文/关闭）+ 内容区。 */
export function PanelShell({ title, modeLabel, context, onClose, children }: PanelShellProps) {
  return (
    <section aria-label={title} className={`content-panel content-panel--${title}`}>
      <header className="panel-header">
        <div className="panel-heading">
          <div className="panel-mark">
            <Sparkles aria-hidden="true" size={ICON_SM} />
          </div>
          <div>
            <h1>{title}</h1>
            <p>
              {modeLabel}模式 <span className="local-dot" /> 本地原型
            </p>
          </div>
        </div>
        {context && <div className="panel-context">{context}</div>}
        <button aria-label="收起面板" className="panel-close" onClick={onClose} type="button">
          <X aria-hidden="true" size={ICON_SM} />
        </button>
      </header>
      {children}
    </section>
  );
}
