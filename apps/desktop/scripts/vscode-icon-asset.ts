import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";

const uiRequire = createRequire(resolve("../../packages/ui/package.json"));
const collectionPath = uiRequire.resolve("@iconify-json/vscode-icons/icons.json");
const assetPath = "/assets/vscode-icons.js";

async function readIconAsset(): Promise<string> {
  const collection = await readFile(collectionPath, "utf8");
  return `window.__ANSWRA_VSCODE_ICON_SET__=${collection};`;
}

/** Keeps the full icon collection intact while excluding its data from renderer JS chunks. */
export function createVscodeIconAssetPlugin(): Plugin {
  let source: Promise<string> | undefined;
  const getSource = () => (source ??= readIconAsset());

  return {
    name: "answra-vscode-icon-asset",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(assetPath, (request, response, next) => {
        if (request.method !== "GET") return next();
        void getSource().then(
          (javascript) => {
            response.setHeader("Content-Type", "text/javascript; charset=utf-8");
            response.end(javascript);
          },
          (error: unknown) => next(error instanceof Error ? error : new Error(String(error))),
        );
      });
    },
    async buildStart() {
      this.emitFile({
        type: "asset",
        fileName: "assets/vscode-icons.js",
        source: await getSource(),
      });
    },
  };
}
