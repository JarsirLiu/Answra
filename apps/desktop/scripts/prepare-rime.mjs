import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.cwd(), "resources", "rime");
const dictionarySource = join(process.cwd(), "native", "rime-data");
const platform =
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : undefined;
if (!platform)
  throw new Error(`librime resource preparation is unsupported on ${process.platform}`);

const library = join(root, platform, platform === "win32" ? "librime.dll" : "librime.dylib");
const helper = join(root, platform, `answra-rime-host${platform === "win32" ? ".exe" : ""}`);
const shared = join(root, "shared");
await mkdir(shared, { recursive: true });
await stat(join(shared, "luna_pinyin.schema.yaml"));
await stat(join(shared, "luna_pinyin_simp.schema.yaml"));
await stat(join(shared, "essay.txt"));
await stat(join(shared, "opencc", "t2s.json"));
await stat(join(shared, "opencc", "TSCharacters.ocd2"));
// librime resolves OpenCC configs relative to shared_data_dir, while the
// upstream deps archive stores them under share/opencc. Keep both the source
// layout and the runtime root copies so the resolver works across releases.
for (const file of ["t2s.json", "TSCharacters.ocd2", "TSPhrases.ocd2"]) {
  await copyFile(join(shared, "opencc", file), join(shared, file));
}
await stat(join(shared, "easy_en.schema.yaml"));
await stat(join(shared, "easy_en.yaml"));
await stat(join(shared, "easy_en.dict.yaml"));
await copyFile(
  join(dictionarySource, "luna_pinyin_simp.custom.yaml"),
  join(shared, "luna_pinyin_simp.custom.yaml"),
);
for (const file of ["easy_en.schema.yaml", "easy_en.yaml", "easy_en.dict.yaml"]) {
  await copyFile(join(dictionarySource, file), join(shared, file));
}
try {
  await stat(library);
  console.log(`[ime] found ${library}`);
} catch {
  console.error(`[ime] missing ${library}`);
  console.error("Download an official librime binary and place its runtime library here.");
  console.error(
    "The package must also contain rime-essay and rime-luna-pinyin data under resources/rime/shared.",
  );
  process.exit(1);
}

await stat(helper);
console.log(`[ime] prebuilt helper ready: ${helper}`);
console.log(`[ime] shared data directory ready: ${shared}`);
