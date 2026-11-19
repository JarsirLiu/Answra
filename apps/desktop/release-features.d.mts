/** 构建期功能表 `release-features.mjs` 的类型声明。 */
export type FeatureGate = "define" | "manifest" | "core" | "declared";

export interface FeatureBuildDefinition {
  readonly gate: FeatureGate;
  readonly forbiddenModules: readonly string[];
}

export interface EntryRule {
  readonly when?: string;
  readonly entry: string;
}

export interface ExtraTarget {
  readonly name: string;
  readonly when: string;
  readonly entry: string;
  readonly outfile: string;
  readonly target: string;
}

export const FEATURES: Readonly<Record<string, FeatureBuildDefinition>>;
export function featureDefineName(feature: string): string;
export function featureDefines(features: readonly string[]): Record<string, string>;
export const ENTRY_RULES: Readonly<Record<string, readonly EntryRule[]>>;
export function resolveEntry(kind: string, features: readonly string[]): string;
export const EXTRA_TARGETS: readonly ExtraTarget[];
