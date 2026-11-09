import { describe, expect, it } from "vitest";
import { buildWorkspaceSystemContext } from "../../../src/conversation/turn/workspaceContext";

describe("workspace system context", () => {
  it("reports the selected root as the default base instead of a boundary", () => {
    const context = buildWorkspaceSystemContext("D:\\notes\\math");

    expect(context).toContain("当前工作区根目录：D:\\notes\\math");
    expect(context).toContain("可以相对于该根目录");
    expect(context).toContain("工作区不是访问边界");
    expect(context).not.toContain("尚未选择工作区目录");
  });

  it("keeps tools available without a workspace when absolute paths are provided", () => {
    const context = buildWorkspaceSystemContext(null);

    expect(context).toContain("尚未选择工作区目录");
    expect(context).toContain("必须提供绝对路径");
    expect(context).not.toContain("不要调用这两个工具");
  });
});
