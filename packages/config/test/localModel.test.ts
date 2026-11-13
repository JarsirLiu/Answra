import { describe, expect, it } from "vitest";
import { mergeLocalModel, normalizeLocalModel } from "../src";

describe("local model helpers", () => {
  it("trims fields, strips trailing slashes, and drops an empty answer model", () => {
    expect(
      normalizeLocalModel({
        baseUrl: " http://127.0.0.1:1234/v1/// ",
        chatModel: " qwen ",
        answerModel: "  ",
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" });
  });

  it("replaces the endpoint and preserves the previous answer model when omitted", () => {
    expect(
      mergeLocalModel(
        { baseUrl: "http://old/v1", chatModel: "old", answerModel: "old-vl" },
        { baseUrl: "http://new/v1/", chatModel: "new" },
      ),
    ).toEqual({ baseUrl: "http://new/v1", chatModel: "new", answerModel: "old-vl" });
  });

  it("keeps the local endpoint when switching the source to cloud", () => {
    expect(
      mergeLocalModel(
        { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen", answerModel: "qwen-vl" },
        { baseUrl: "", chatModel: "" },
      ),
    ).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "qwen",
      answerModel: "qwen-vl",
    });
  });

  it("treats whitespace-only patch fields as absent", () => {
    expect(
      mergeLocalModel(
        { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" },
        { baseUrl: " ", chatModel: " " },
      ),
    ).toEqual({ baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" });
  });
});
