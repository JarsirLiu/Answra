import { describe, expect, it } from "vitest";
import {
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_INDEX_MAX_ENTRIES,
  type SkillInfo,
} from "../../../src/core/skill/contracts";
import { renderSkillIndex, selectSkills } from "../../../src/core/skill/guidance";

function skill(name: string, description = `${name} 描述`): SkillInfo {
  return {
    name,
    description,
    directory: `/skills/${name}`,
    content: "正文",
    source: "builtin",
  };
}

describe("selectSkills", () => {
  it("hides every skill when the profile declares no allowlist", () => {
    expect(selectSkills([skill("a"), skill("b")], undefined)).toEqual([]);
    expect(selectSkills([skill("a")], [])).toEqual([]);
  });

  it("keeps only allowlisted names and never treats a wildcard as a match", () => {
    const selected = selectSkills([skill("a"), skill("b"), skill("c")], ["a", "c"]);

    expect(selected.map((item) => item.name)).toEqual(["a", "c"]);
    expect(selectSkills([skill("a")], ["*"])).toEqual([]);
  });
});

describe("renderSkillIndex", () => {
  it("returns an empty string when there is nothing to list", () => {
    expect(renderSkillIndex([])).toBe("");
  });

  it("renders name and description as xml entries sorted by name", () => {
    const rendered = renderSkillIndex([skill("zeta"), skill("alpha")]);

    expect(rendered).toContain("<available_skills>");
    expect(rendered).toContain("</available_skills>");
    expect(rendered.indexOf("<name>alpha</name>")).toBeLessThan(
      rendered.indexOf("<name>zeta</name>"),
    );
    expect(rendered).toContain("<description>alpha 描述</description>");
  });

  it("never leaks skill body text into the index", () => {
    const rendered = renderSkillIndex([{ ...skill("a"), content: "机密正文" }]);

    expect(rendered).not.toContain("机密正文");
  });

  it("truncates an over-long description", () => {
    const long = "描述".repeat(SKILL_DESCRIPTION_MAX_CHARS);
    const rendered = renderSkillIndex([skill("a", long)]);
    const match = /<description>([\s\S]*?)<\/description>/.exec(rendered);

    expect(match?.[1]).toHaveLength(SKILL_DESCRIPTION_MAX_CHARS + 1);
    expect(match?.[1]?.endsWith("…")).toBe(true);
  });

  it("caps the number of entries and tells the model the list is truncated", () => {
    const many = Array.from({ length: SKILL_INDEX_MAX_ENTRIES + 5 }, (_, index) =>
      skill(`skill-${String(index).padStart(3, "0")}`),
    );

    const rendered = renderSkillIndex(many);

    expect(rendered.match(/<skill>/g)).toHaveLength(SKILL_INDEX_MAX_ENTRIES);
    expect(rendered).toContain("5 more skill(s) are not listed");
  });
});
