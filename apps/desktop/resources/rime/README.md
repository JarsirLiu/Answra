# Bundled librime resources

Place the official platform runtime and dictionaries here before packaging:

```text
rime/
  win32/librime.dll
  darwin/librime.dylib
  shared/essay.txt
  shared/luna_pinyin_simp.schema.yaml
  shared/luna_pinyin.dict.yaml
  shared/easy_en.schema.yaml
  shared/easy_en.yaml
  shared/easy_en.dict.yaml
  shared/opencc/t2s.json
  shared/opencc/*.ocd2
```

`pnpm --filter @answra/desktop ime:prepare` validates the current platform.
The helper is shipped as a prebuilt binary beside the runtime library; this
command never invokes CMake. Missing resources disable input; the
application never falls back to the system input method. The files are copied
outside ASAR by electron-builder.

The selected schema is `luna_pinyin_simp`. Its base dictionaries are official
`rime-luna-pinyin` and `rime-essay`; OpenCC data from the official librime
dependency package provides Traditional-to-Simplified conversion. The upstream
community `rime-easy-en` dictionary is included through the schema patch for
English completion and mixed Chinese/English terms. No project dictionary
replaces the official `luna_pinyin` translator.
