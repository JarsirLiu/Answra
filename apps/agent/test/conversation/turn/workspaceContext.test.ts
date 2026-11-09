import { describe, expect, it } from "vitest";
import { buildWorkspaceSystemContext } from "../../../src/conversation/turn/workspaceContext";

describe("workspace system context", () => {
  it("reports the selected root as the default base instead of a boundary", () => {
    const context = buildWorkspaceSystemContext("D:\\notes\\math");

    expect(context).toContain("当前工作区根目录：D:\\notes\\math");
    expect(context).toContain("相对路径以该根目录为默认基线");
    expect(context).toContain("省略路径时默认查看整个工作区");
    expect(context).toContain("工作区不是访问边界");
    expect(context).not.toContain("尚未选择工作区目录");
    expect(context).not.toMatch(/\b(Read|Grep)\b/);
  });

  it("requires absolute paths without a workspace and does not narrate tool capabilities", () => {
    const context = buildWorkspaceSystemContext(null);

    expect(context).toContain("尚未选择工作区目录");
    expect(context).toContain("必须使用绝对路径");
    expect(context).not.toMatch(/\b(Read|Grep)\b/);
  });
});
