import { Check } from "lucide-react";
import { ICON_SM } from "../../tokens";
import { PanelShell } from "./PanelShell";

interface NotesPanelProps {
  note: string;
  modeLabel: string;
  onNoteChange: (value: string) => void;
  onClose: () => void;
}

/** 笔记本面板：备忘录式草稿，本地自动保存。 */
export function NotesPanel({ note, modeLabel, onNoteChange, onClose }: NotesPanelProps) {
  return (
    <PanelShell modeLabel={modeLabel} onClose={onClose} title="笔记本">
      <div className="notes-panel">
        <label htmlFor="exam-note">个人笔记</label>
        <textarea
          id="exam-note"
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
