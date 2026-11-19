/** Release profile contract shared by build tooling and the packaged app. */

/**
 * 功能目录：构建期 define、打包输入审计和安装包清单共用同一份 ID。
 * 新增功能时同步 `release-features.json` 与 `apps/desktop/release-features.mjs`。
 */
export const FEATURE_IDS = [
  "answer",
  "chat",
  "workspace",
  "interview",
  "settings",
  "account",
  "announcements",
  "updates",
  "stealth",
  "local-model",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

/**
 * Profile 是开放集合：合法 ID 由 `apps/desktop/release-profiles.json` 定义，
 * 新增发行版本只改该配置，不在代码里维护封闭联合。
 */
export type ReleaseProfile = string;

export interface ReleaseManifest {
  schemaVersion: 2;
  profile: ReleaseProfile;
  features: readonly FeatureId[];
}
