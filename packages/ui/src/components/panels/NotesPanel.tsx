import { Check } from "lucide-react";
import { ICON_SM } from "../../tokens";
import { PanelShell } from "./PanelShell";
import "./NotesPanel.css";

interface NotesPanelProps {
  note: string;
  onNoteChange: (value: string) => void;
  onClose: () => void;
}

/** 笔记本面板：备忘录式草稿，本地自动保存。 */
export function NotesPanel({ note, onNoteChange, onClose }: NotesPanelProps) {
  return (
    <PanelShell onClose={onClose} title="笔记本" variant="notes">
      <div className="notes-panel">
        <label htmlFor="exam-note">个人笔记</label>
        <textarea
          id="exam-note"
          className="input-surface"
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="记录要点、思路或待确认的问题…"
          value={note}
        />
        <span className="saved-state">
          <Check aria-hidden="true" size={ICON_SM} /> 自动保存在本机
        </span>
      </div>
    </PanelShell>
  );
}
