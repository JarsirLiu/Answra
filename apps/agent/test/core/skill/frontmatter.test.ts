import { describe, expect, it } from "vitest";
import { parseSkillDocument } from "../../../src/core/skill/frontmatter";

describe("parseSkillDocument", () => {
  it("extracts name and description and trims the body", () => {
    const parsed = parseSkillDocument(
      [
        "---",
        "name: resume-rewrite",
        "description: 改写简历时使用。",
        "---",
        "",
        "# 标题",
        "正文",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      frontmatter: { name: "resume-rewrite", description: "改写简历时使用。" },
      content: "# 标题\n正文",
    });
  });

  it("keeps a colon inside the description value", () => {
    const parsed = parseSkillDocument(
      ["---", "name: demo", "description: 用途: 写简历", "---", "body"].join("\n"),
    );

    expect(parsed?.frontmatter.description).toBe("用途: 写简历");
  });

  it("strips matching quotes around values", () => {
    const parsed = parseSkillDocument(
      ["---", 'name: "demo"', "description: '单引号描述'", "---", "body"].join("\n"),
    );

    expect(parsed?.frontmatter).toEqual({ name: "demo", description: "单引号描述" });
  });

  it("ignores unknown keys so frontmatter can grow", () => {
    const parsed = parseSkillDocument(
      ["---", "name: demo", "description: 描述", "slash: true", "---", "body"].join("\n"),
    );

    expect(parsed?.frontmatter).toEqual({ name: "demo", description: "描述" });
  });

  it("returns undefined when the document has no frontmatter", () => {
    expect(parseSkillDocument("# 只有正文")).toBeUndefined();
  });

  it("returns undefined when the closing delimiter is missing", () => {
    expect(parseSkillDocument(["---", "name: demo", "body"].join("\n"))).toBeUndefined();
  });

  it("returns undefined for a line that is not a key/value pair", () => {
    const parsed = parseSkillDocument(
      ["---", "name: demo", "  - 列表项", "---", "body"].join("\n"),
    );

    expect(parsed).toBeUndefined();
  });

  it("treats an empty description as absent", () => {
    const parsed = parseSkillDocument(
      ["---", "name: demo", "description:", "---", "body"].join("\n"),
    );

    expect(parsed?.frontmatter.description).toBeUndefined();
  });

  it("handles CRLF line endings and a BOM", () => {
    const parsed = parseSkillDocument(
      "\uFEFF---\r\nname: demo\r\ndescription: 描述\r\n---\r\nbody\r\n",
    );

    expect(parsed?.frontmatter).toEqual({ name: "demo", description: "描述" });
    expect(parsed?.content).toBe("body");
  });

  it("ignores comment lines inside frontmatter", () => {
    const parsed = parseSkillDocument(
      ["---", "# 注释", "name: demo", "description: 描述", "---", "body"].join("\n"),
    );

    expect(parsed?.frontmatter.name).toBe("demo");
  });
});
