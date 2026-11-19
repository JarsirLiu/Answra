/**
 * 构建期功能表：功能 ID → 编译期 define、禁止可达模块，以及随功能切换的构建入口。
 *
 * 这份表只被打包脚本读取，不进运行时代码；运行时功能目录是
 * `packages/shared/src/release-features.json`，两者一致性由 `pnpm profiles:check` 校验。
 */

/**
 * 功能表。`gate` 声明该功能靠什么生效，供 `profiles:check` 验证：
 * - `define`：编译期常量必须在源码中被引用；
 * - `manifest`：发布清单的功能位必须在源码中被读取；
 * - `core`：核心能力，每个 Profile 都必须包含；
 * - `declared`：只在清单与打包配置里登记，暂未接运行时门禁（技术债，检查时会提示）。
 */
export const FEATURES = {
  answer: { gate: "core", forbiddenModules: [] },
  chat: {
    gate: "define",
    forbiddenModules: [
      "packages/ui/src/components/panels/ChatPanel",
      "agent/src/conversation/application.ts",
      "agent/src/conversation/profiles/registry.ts",
    ],
  },
  workspace: {
    gate: "define",
    forbiddenModules: [
      "packages/ui/src/components/panels/workspace/",
      "src/main/workspace/composition.ts",
      "src/main/workspace/fileProtocol.ts",
      "src/main/workspace/workspaceIpc.ts",
      "src/main/workspace/workspaceService.ts",
      "agent/src/core/tool/",
    ],
  },
  interview: {
    gate: "define",
    forbiddenModules: [
      "packages/ui/src/components/panels/InterviewCapturePanel",
      "src/main/interview/",
      "src/main/conversation/worker.ts",
      "src/main/conversation/workerTransport.ts",
      "agent/src/interview/audio/",
      "agent/src/interview/turns/",
      "agent/src/interview/vad/",
      "agent/src/interview/transcription/",
    ],
  },
  settings: { gate: "declared", forbiddenModules: [] },
  account: { gate: "declared", forbiddenModules: [] },
  announcements: { gate: "declared", forbiddenModules: [] },
  updates: { gate: "declared", forbiddenModules: [] },
  stealth: { gate: "declared", forbiddenModules: [] },
  "local-model": { gate: "manifest", forbiddenModules: [] },
};

/** 功能 ID → 编译期常量名（`local-model` → `__ANSWRA_FEATURE_LOCAL_MODEL__`）。 */
export function featureDefineName(feature) {
  return `__ANSWRA_FEATURE_${feature.toUpperCase().replaceAll("-", "_")}__`;
}

/** 生成 esbuild/Vite 的 define；未包含的功能一律编译为 false。 */
export function featureDefines(features) {
  return Object.fromEntries(
    Object.keys(FEATURES).map((feature) => [
      featureDefineName(feature),
      String(features.includes(feature)),
    ]),
  );
}

/**
 * 入口规则：按顺序取第一条 `when` 命中的规则；无 `when` 的是兜底。
 * 新功能要替换某个进程入口时，在这里加一行，禁止在脚本里按 profile 名字分支。
 */
export const ENTRY_RULES = {
  "agent-worker": [
    { when: "interview", entry: "src/main/conversation/worker.ts" },
    { entry: "src/main/conversation/workerAnswer.ts" },
  ],
  preload: [
    { when: "interview", entry: "src/preload/index.ts" },
    { entry: "src/preload/answer.ts" },
  ],
};

/** 解析某个构建入口在当前功能集合下使用哪个源文件。 */
export function resolveEntry(kind, features) {
  const rules = ENTRY_RULES[kind];
  if (!rules) throw new Error(`未知构建入口：${kind}`);
  const matched = rules.find((rule) => !rule.when || features.includes(rule.when));
  if (!matched) throw new Error(`${kind} 缺少匹配当前功能集合的入口规则`);
  return matched.entry;
}

/** 某个功能开启时才追加的额外构建目标。 */
export const EXTRA_TARGETS = [
  {
    name: "grep-worker",
    when: "chat",
    entry: "src/main/conversation/grepWorker.ts",
    outfile: "out/main/conversation/grepWorker.cjs",
    target: "node22.14",
  },
];
