/** Release profile contract shared by build tooling and the packaged app. */
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
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];
export const RELEASE_PROFILES = ["answer", "full"] as const;
export type ReleaseProfile = (typeof RELEASE_PROFILES)[number];

export interface ReleaseManifest {
  schemaVersion: 1;
  profile: ReleaseProfile;
  features: readonly FeatureId[];
}
