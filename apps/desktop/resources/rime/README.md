# Bundled librime resources

Run `pnpm --filter @answra/desktop ime:prepare` to download and verify the
current platform's official librime runtime, OpenCC data, Rime dictionaries,
and the prebuilt Answra helper. The version and SHA-256 pins are in
`apps/desktop/native/rime-resources.json`. The helper release is built by
`.github/workflows/rime-host-release.yml` from the tag pinned in that manifest
(currently `answra-rime-host-v2.0.0`); the tag release and its `SHA256SUMS`
must be published before `ime:prepare` can succeed.

Downloads are cached in `apps/desktop/.cache-rime/`; prepared runtime files
are written here and shipped outside ASAR. Neither directory is committed.
The command does not compile native code. Missing or unverifiable resources
fail preparation; the application never falls back to the system IME.

The schema is `luna_pinyin_simp`. It uses upstream `rime-luna-pinyin`,
`rime-stroke`, `rime-essay`, `rime-prelude`, OpenCC data from librime deps,
and upstream `rime-easy-en` through the checked-in schema patch.
