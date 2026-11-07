import { describe, expect, it } from "vitest";
import { buildWorkspaceSystemContext } from "../../../src/conversation/turn/workspaceContext";

describe("workspace system context", () => {
  it("reports the selected root and how workspace-relative tools resolve it", () => {
    const context = buildWorkspaceSystemContext("D:\\notes\\math");

    expect(context).toContain("当前工作区根目录：D:\\notes\\math");
    expect(context).toContain("相对于该根目录");
    expect(context).not.toContain("尚未选择工作区目录");
  });

  it("declares the workspace tools unavailable instead of letting the model call them", () => {
    const context = buildWorkspaceSystemContext(null);

    expect(context).toContain("尚未选择工作区目录");
    expect(context).toContain("不要调用这两个工具");
  });
});
