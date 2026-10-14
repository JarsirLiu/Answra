import type { ImeState } from "@answra/shared";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { ICON_SM } from "../../tokens";
import "./ImeCandidatePopup.css";

interface ImeCandidatePopupProps {
  state: ImeState;
  onSelect: (index: number) => void;
  onNavigate: (key: string) => void;
}

export function ImeCandidatePopup({ state, onSelect, onNavigate }: ImeCandidatePopupProps) {
  if (!state.enabled || (!state.preedit && state.candidates.length === 0)) return null;
  return (
    <div aria-label="输入法候选词" className="ime-candidate-popup" role="listbox">
      {state.preedit && <div className="ime-candidate-preedit">{state.preedit}</div>}
      <div className="ime-candidate-row">
        <div className="ime-candidate-options">
          {state.candidates.map((candidate, index) => (
            <button
              aria-selected={index === state.selectedIndex}
              className={`ime-candidate-item${index === state.selectedIndex ? " is-selected" : ""}`}
              key={`${candidate.text}:${candidate.comment ?? ""}`}
              onClick={() => onSelect(index)}
              role="option"
              type="button"
            >
              <span className="ime-candidate-index">{index + 1}</span>
              <span className="ime-candidate-text">{candidate.text}</span>
              {candidate.comment && (
                <span className="ime-candidate-comment">{candidate.comment}</span>
              )}
            </button>
          ))}
        </div>
        {state.candidates.length > 0 && (
          <div className="ime-candidate-controls">
            <button
              aria-label="上翻候选页"
              className="ime-candidate-control"
              disabled={state.page <= 0}
              onClick={() => onNavigate("PageUp")}
              type="button"
            >
              <ChevronUp aria-hidden="true" size={ICON_SM} />
            </button>
            <button
              aria-label="下翻候选页"
              className="ime-candidate-control"
              disabled={!state.hasNextPage}
              onClick={() => onNavigate("PageDown")}
              type="button"
            >
              <ChevronDown aria-hidden="true" size={ICON_SM} />
            </button>
            <button
              aria-label="向左选择候选词"
              className="ime-candidate-control"
              onClick={() => onNavigate("ArrowLeft")}
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={ICON_SM} />
            </button>
            <button
              aria-label="向右选择候选词"
              className="ime-candidate-control"
              onClick={() => onNavigate("ArrowRight")}
              type="button"
            >
              <ChevronRight aria-hidden="true" size={ICON_SM} />
            </button>
            <span className="ime-candidate-page" title={`第 ${state.page + 1} 页`}>
              {state.page + 1}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
