import type { OverlayMode } from "@answra/shared";
import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  ClipboardList,
  MessagesSquare,
  NotebookPen,
  ScanLine,
  Sparkles,
  UsersRound,
} from "lucide-react";

export type Mode = "exam" | "interview" | "meeting";

/** 内容面板标识；`closed` 表示当前只显示悬浮条。 */
export type Panel = Exclude<OverlayMode, "closed"> | "closed";

export interface ModeAction {
  id: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  /** 悬停时展示的能力说明（用于占位入口）。 */
  hint?: string;
}

export interface ModeDefinition {
  id: Mode;
  label: string;
  icon: LucideIcon;
  actions: readonly ModeAction[];
}

export const MODES: readonly ModeDefinition[] = [
  {
    id: "exam",
    label: "笔试",
    icon: ClipboardList,
    actions: [
      { id: "screenshot", label: "截图提问", icon: ScanLine },
      { id: "chat", label: "AI 对话", icon: MessagesSquare },
    ],
  },
  {
    id: "interview",
    label: "面试",
    icon: AudioLines,
    actions: [
      {
        id: "suggest",
        label: "AI 建议（即将推出）",
        icon: Sparkles,
        disabled: true,
        hint: "后续将区分系统声音（对方）与麦克风（用户），实时生成回答建议",
      },
      { id: "chat", label: "AI 对话", icon: MessagesSquare },
    ],
  },
  {
    id: "meeting",
    label: "会议",
    icon: UsersRound,
    actions: [
      { id: "record", label: "会议记录", icon: NotebookPen },
      { id: "chat", label: "AI 对话", icon: MessagesSquare },
    ],
  },
];

export const WELCOME_MESSAGE =
  "选择一个功能开始。笔试模式可以添加题目截图，再补充问题一起发送；会议模式可用会议记录记要点。";

export const NOTE_STORAGE_KEY = "answra-note";

/** 旧版 localStorage 笔记是否已迁移到工作区的标记键（值为 "1"）。 */
export const NOTE_MIGRATED_FLAG = "answra-note-migrated";

/** 变色龙主题开关的本地持久化键；缺省视为关闭。 */
export const AMBIENT_FOLLOW_STORAGE_KEY = "answra-ambient-follow";

/** 变色龙「隐蔽强度」的本地持久化键；缺省为「隐蔽」。 */
export const AMBIENT_VEIL_STORAGE_KEY = "answra-ambient-veil";

/**
 * 隐蔽强度档位（由贴得最紧到最清晰）。
 * 越靠前的档位前景对比度越低：静置的悬浮层更接近背景，远距离与拍照越难察觉，
 * 代价是近距离可读性下降；`readable` 回到 WCAG AA，作为无障碍兜底。
 */
export const AMBIENT_VEIL_LEVELS = ["blend", "veiled", "balanced", "readable"] as const;

export type AmbientVeilLevel = (typeof AMBIENT_VEIL_LEVELS)[number];

/** 缺省档位：静置时基本融入背景，一臂距离内仍可读。 */
export const DEFAULT_AMBIENT_VEIL: AmbientVeilLevel = "veiled";

export const AMBIENT_VEIL_LABELS: Record<AmbientVeilLevel, string> = {
  blend: "贴合",
  veiled: "隐蔽",
  balanced: "均衡",
  readable: "清晰",
};

export const AMBIENT_VEIL_HINTS: Record<AmbientVeilLevel, string> = {
  blend: "几乎完全贴背景：远距离与拍照最难察觉，近距离也最难读",
  veiled: "静置时融入背景，一臂距离内可读（默认）",
  balanced: "可读性与隐蔽性折中",
  readable: "满足 WCAG AA 对比度，最清晰也最显眼",
};

/** 整体透明度（0.5~1）的本地持久化键；缺省为 1。 */
export const APP_OPACITY_STORAGE_KEY = "answra-opacity";

/** 会议隐身（内容保护）开关的本地持久化键；缺省视为关闭。 */
export const STEALTH_STORAGE_KEY = "answra-stealth";

/** 用户颜色分组覆盖的本地持久化键前缀；完整键为 `${前缀}${分组id}`，值是 hex 颜色。 */
export const COLOR_GROUP_STORAGE_PREFIX = "answra-color-group-";
