import { describe, expect, it } from "vitest";
import { extractResumeProjects } from "../src/main/interview/resumeProjects";

describe("resume project extraction", () => {
  it("extracts markdown project headings and stops at the next section", () => {
    const projects = extractResumeProjects(`
# 张三

## 项目经历

### Answra 桌面助手 | 前端负责人 | 2024.01-2025.06
- 负责桌面端引导与面试面板。
- 使用 TypeScript 和 React。

### 数据平台 | 全栈开发 | 2023.03-2023.12
- 负责数据看板和权限模块。

## 教育经历

### 某大学
- 计算机科学
`);

    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({
      name: "Answra 桌面助手",
      role: "前端负责人",
      period: "2024.01-2025.06",
    });
    expect(projects[0]?.summary).toContain("负责桌面端引导");
    expect(projects[1]?.name).toBe("数据平台");
    expect(projects[1]?.summary).toContain("负责数据看板");
  });

  it("extracts plain-text project titles followed by bullets", () => {
    const projects = extractResumeProjects(`
项目经历
Answra 桌面助手 2024.01-2025.06
- 负责桌面端引导。
数据平台
- 负责权限模块。

技能
TypeScript
`);

    expect(projects.map((project) => project.name)).toEqual([
      "Answra 桌面助手 2024.01-2025.06",
      "数据平台",
    ]);
    expect(projects[1]?.summary).toBe("负责权限模块。");
  });

  it("does not guess when there is no project section", () => {
    expect(extractResumeProjects("张三\n前端工程师\n- 熟悉 TypeScript")).toEqual([]);
  });

  it("ignores repeated project names", () => {
    const projects = extractResumeProjects(`
## 项目经历
### 同一个项目
- 第一条
### 同一个项目
- 第二条
`);

    expect(projects).toHaveLength(1);
    expect(projects[0]?.summary).toBe("第一条");
  });
});
