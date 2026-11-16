import { describe, expect, it } from "vitest";
import {
  configPanelFooter,
  displayConfigValue,
  filterConfigRows,
} from "../../../src/tui/commands/configPresentation";

const values = {
  baseUrl: "http://127.0.0.1:1234/v1",
  apiKey: "sk-existing-1234",
  chatModel: "qwen",
  answerModel: "",
};

const data = {
  baseUrl: values.baseUrl,
  chatModel: values.chatModel,
  apiKey: values.apiKey,
};

describe("configPresentation", () => {
  it("filters rows by label without changing their order", () => {
    expect(filterConfigRows("api").map((row) => row.field)).toEqual(["apiKey"]);
    expect(filterConfigRows("模型").map((row) => row.field)).toEqual(["chatModel", "answerModel"]);
    expect(filterConfigRows("")).toHaveLength(4);
  });

  it("masks the API key unless the editor reveals it", () => {
    expect(displayConfigValue("apiKey", values, data, false)).toBe("已保存 · ••••1234");
    expect(displayConfigValue("apiKey", values, data, true)).toBe("已保存 · sk-existing-1234");
  });

  it("shows the answer fallback and unconfigured values", () => {
    expect(displayConfigValue("answerModel", values, data, false)).toBe("与 Chat 相同");
    expect(
      displayConfigValue("baseUrl", { ...values, baseUrl: "" }, { ...data, baseUrl: "" }, false),
    ).toBe("(未配置)");
  });

  it("describes the active keyboard mode in the footer", () => {
    expect(
      configPanelFooter({
        busy: true,
        loaded: true,
        editing: undefined,
        searching: false,
      }),
    ).toBe("正在保存…");
    expect(
      configPanelFooter({
        busy: false,
        loaded: true,
        editing: undefined,
        searching: true,
      }),
    ).toBe("输入筛选 · Enter/↓ 进入列表 · Esc 清除");
    expect(
      configPanelFooter({
        busy: false,
        loaded: true,
        editing: "apiKey",
        searching: false,
      }),
    ).toBe("Enter 确认 · Ctrl+R 显示/隐藏 · Esc 取消编辑");
    expect(
      configPanelFooter({
        busy: false,
        loaded: true,
        editing: undefined,
        searching: false,
      }),
    ).toBe("Enter/→ 修改 · Ctrl+S 保存 · / 搜索 · Esc 取消");
    expect(
      configPanelFooter({
        busy: false,
        loaded: true,
        editing: undefined,
        searching: false,
        selectedField: "apiKey",
      }),
    ).toBe("Enter/→ 修改 · Ctrl+R 显示/隐藏 Key · Ctrl+S 保存 · / 搜索 · Esc 取消");
  });
});
