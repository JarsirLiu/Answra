import { X } from "lucide-react";
import type { ReactNode } from "react";
import { ICON_SM } from "../../tokens";
import "./PanelShell.css";

export interface PanelTab {
  id: string;
  label: string;
  /** Tab 上的未读计数角标；0 或缺省不显示。 */
  badge?: number;
}

interface PanelShellProps {
  title: string;
  /** 面板变体，对应 PanelShell.css 的 content-panel--<variant> 尺寸分支。 */
  variant: "chat" | "notes" | "settings" | "account" | "interview";
  /** 头部右侧的上下文提示（如“截图已添加”）。 */
  context?: string;
  /** 头部关闭钮左侧的动作位（如「清空对话」）；缺省不渲染。 */
  headerAction?: ReactNode;
  /** 附加到 section 的自定义类名（如回复条 layout 约束）。 */
  className?: string;
  /** 多入口面板的 Tab 栏（账户/设置/公告这类）；提供时 Tab 栏即面板头部（右侧关闭钮），不再渲染标题。 */
  tabs?: readonly PanelTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  onClose: () => void;
  children: ReactNode;
}

/** 内容面板通用外壳：头部（标题/上下文/关闭，或 Tab 栏）+ 内容区。 */
export function PanelShell({
  title,
  variant,
  context,
  headerAction,
  className,
  tabs,
  activeTab,
  onTabChange,
  onClose,
  children,
}: PanelShellProps) {
  const tabsNode = tabs && (
    <>
      <div aria-label={`${title}的入口`} className="panel-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            aria-selected={tab.id === activeTab}
            className="panel-tab"
            key={tab.id}
            onClick={() => onTabChange?.(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
            {tab.badge ? (
              <span aria-hidden="true" className="panel-tab-badge">
                {tab.badge > 9 ? "9+" : tab.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <button aria-label="收起面板" className="panel-close" onClick={onClose} type="button">
        <X aria-hidden="true" size={ICON_SM} />
      </button>
    </>
  );
  return (
    <section
      aria-label={title}
      className={`content-panel content-panel--${variant}${className ? ` ${className}` : ""}`}
    >
      {tabs ? (
        <div className="panel-header panel-header--tabs">{tabsNode}</div>
      ) : (
        <header className="panel-header">
          <h1 className="panel-title" title={title}>
            {title}
          </h1>
          {context && <div className="panel-context">{context}</div>}
          {headerAction}
          <button aria-label="收起面板" className="panel-close" onClick={onClose} type="button">
            <X aria-hidden="true" size={ICON_SM} />
          </button>
        </header>
      )}
      {children}
    </section>
  );
}
