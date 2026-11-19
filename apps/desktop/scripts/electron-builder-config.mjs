/**
 * 把 `release-profiles.json` 的 `builder` 覆盖块应用到 electron-builder 配置。
 *
 * 语义固定为：标量/数组覆盖（`extraResources`、`asarUnpack` 替换），
 * `extraResourcesAppend` 追加资源，`filesExclude` 追加为 `!pattern`。
 * 覆盖键的合法性由 `release-profile.mjs` 解析时校验，这里不再猜测。
 */
export function applyReleaseBuilder(config, builder) {
  if (builder.appId !== undefined) config.appId = builder.appId;
  if (builder.productName !== undefined) config.productName = builder.productName;
  if (builder.output !== undefined) config.directories.output = builder.output;
  if (builder.nsisArtifactName !== undefined) config.nsis.artifactName = builder.nsisArtifactName;
  if (builder.asarUnpack !== undefined) config.asarUnpack = builder.asarUnpack;
  if (builder.extraResources !== undefined) config.extraResources = builder.extraResources;
  if (builder.extraResourcesAppend !== undefined) {
    config.extraResources = [...config.extraResources, ...builder.extraResourcesAppend];
  }
  if (builder.filesExclude !== undefined) {
    config.files.push(...builder.filesExclude.map((pattern) => `!${pattern}`));
  }
  return config;
}
