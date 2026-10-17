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

/** 整体透明度（0.5~1）的本地持久化键；缺省为 1。 */
export const APP_OPACITY_STORAGE_KEY = "answra-opacity";

/** 会议隐身（内容保护）开关的本地持久化键；缺省视为关闭。 */
export const STEALTH_STORAGE_KEY = "answra-stealth";

/** 用户颜色分组覆盖的本地持久化键前缀；完整键为 `${前缀}${分组id}`，值是 hex 颜色。 */
export const COLOR_GROUP_STORAGE_PREFIX = "answra-color-group-";
