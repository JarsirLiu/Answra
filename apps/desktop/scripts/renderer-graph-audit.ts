import { mkdir, writeFile } from "node:fs/promises";
import type { ReleaseProfile } from "@answra/shared";
import type { Plugin } from "vite";

/** Records the rendered module graph for the post-build release audit. */
export function createRendererGraphAudit(profile: ReleaseProfile): Plugin {
  return {
    name: "answra-renderer-graph-audit",
    async generateBundle(_options, bundle) {
      const moduleIds = Object.values(bundle)
        .filter((output) => output.type === "chunk")
        .flatMap((output) =>
          Object.entries(output.modules)
            .filter(([, info]) => info.renderedLength > 0)
            .map(([moduleId]) => moduleId),
        );
      const auditDirectory = `.release-audit/${profile}`;
      await mkdir(auditDirectory, { recursive: true });
      await writeFile(
        `${auditDirectory}/renderer-modules.json`,
        `${JSON.stringify(moduleIds, null, 2)}\n`,
      );
    },
  };
}
