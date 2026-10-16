import type { ImeState } from "@answra/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ICON_SM } from "../../tokens";
import "./ImeCandidatePopup.css";

interface ImeCandidatePopupProps {
  state: ImeState;
  onSelect: (index: number) => void;
  onNavigate: (key: string) => void;
}

/**
 * 候选词窗口：复刻 Windows 微软拼音的横向候选条 ——
 * 左侧蓝色竖条 + 编号/词条横排 + 选中项整块高亮 + 右侧翻页箭头。
 * 组合文本由编辑器呈现；此 surface 只呈现候选和导航操作。
 */
export function ImeCandidatePopup({ state, onSelect, onNavigate }: ImeCandidatePopupProps) {
  if (!state.enabled || state.candidates.length === 0) return null;
  return (
    <div aria-label="输入法候选词" className="ime-candidate-popup" role="listbox">
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
            aria-label="上一页候选"
            className="ime-candidate-control"
            disabled={state.page <= 0}
            onClick={() => onNavigate("PageUp")}
            title="上一页候选"
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={ICON_SM} />
          </button>
          <button
            aria-label="下一页候选"
            className="ime-candidate-control"
            disabled={!state.hasNextPage}
            onClick={() => onNavigate("PageDown")}
            title="下一页候选"
            type="button"
          >
            <ChevronRight aria-hidden="true" size={ICON_SM} />
          </button>
        </div>
      )}
    </div>
  );
}
