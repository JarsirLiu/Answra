import type { OverlayMode } from "@answra/shared";
import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  ClipboardList,
  MessagesSquare,
  ScanLine,
  Sparkles,
  UsersRound,
} from "lucide-react";

export type Mode = "conversation" | "exam" | "interview" | "meeting";

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
    id: "conversation",
    label: "对话",
    icon: MessagesSquare,
    actions: [{ id: "chat", label: "打开对话", icon: MessagesSquare }],
  },
  {
    id: "exam",
    label: "答题",
    icon: ClipboardList,
    actions: [{ id: "screenshot", label: "截图提问", icon: ScanLine }],
  },
  {
    id: "interview",
    label: "面试",
    icon: AudioLines,
    actions: [
      {
        id: "suggest",
        label: "面试辅助（即将推出）",
        icon: Sparkles,
        disabled: true,
        hint: "实时生成回答建议",
      },
    ],
  },
  {
    id: "meeting",
    label: "会议",
    icon: UsersRound,
    actions: [
      {
        id: "meeting",
        label: "会议助手（即将推出）",
        icon: Sparkles,
        disabled: true,
        hint: "会议记录与总结功能即将推出",
      },
    ],
  },
];

export const WELCOME_MESSAGE = "在对话模式中开始交流，或切换到答题模式发送题目截图。";

export const NOTE_STORAGE_KEY = "answra-note";

/** 旧版 localStorage 笔记是否已迁移到工作区的标记键（值为 "1"）。 */
export const NOTE_MIGRATED_FLAG = "answra-note-migrated";

/** 变色龙主题开关的本地持久化键；缺省视为关闭。 */
export const AMBIENT_FOLLOW_STORAGE_KEY = "answra-ambient-follow";

/** 旧版变色龙「隐蔽强度」档位的本地持久化键；该功能已移除，仅用于清理残留值。 */
export const AMBIENT_VEIL_STORAGE_KEY = "answra-ambient-veil";

/** 整体透明度（0.5~1）的本地持久化键；缺省为 1。 */
export const APP_OPACITY_STORAGE_KEY = "answra-opacity";

/** 会议隐身（内容保护）开关的本地持久化键；缺省视为关闭。 */
export const STEALTH_STORAGE_KEY = "answra-stealth";

/** 用户颜色分组覆盖的本地持久化键前缀；完整键为 `${前缀}${分组id}`，值是 hex 颜色。 */
export const COLOR_GROUP_STORAGE_PREFIX = "answra-color-group-";
