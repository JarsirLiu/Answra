import { FileText } from "lucide-react";
import type { ChangeEvent } from "react";
import { ICON_SM } from "../../tokens";
import { PanelShell } from "./PanelShell";
import "./SourcesPanel.css";

interface SourcesPanelProps {
  sources: string[];
  onSourcesChange: (names: string[]) => void;
  onClose: () => void;
}

/** 参考资料面板：选择本地文件，原型仅显示文件名。 */
export function SourcesPanel({ sources, onSourcesChange, onClose }: SourcesPanelProps) {
  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    onSourcesChange(Array.from(event.target.files ?? [], (file) => file.name));
  }

  return (
    <PanelShell onClose={onClose} title="参考资料" variant="sources">
      <div className="sources-panel">
        <div className="sources-title">
          <FileText aria-hidden="true" size={ICON_SM + 1} />
          <strong>参考资料</strong>
        </div>
        <p>添加本地文件作为后续分析资料；当前仅显示文件名，不会读取或上传内容。</p>
        <label className="file-picker">
          添加本地文件
          <input multiple onChange={handleFiles} type="file" />
        </label>
        <ul className="source-list">
          {sources.map((source) => (
            <li key={source}>
              <FileText aria-hidden="true" size={ICON_SM} /> {source}
            </li>
          ))}
        </ul>
      </div>
    </PanelShell>
  );
}
