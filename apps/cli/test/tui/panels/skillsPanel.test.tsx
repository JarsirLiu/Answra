import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { CodingSkillSummary } from "../../../src/session/codingSession";
import { POINTER } from "../../../src/tui/chrome/theme";
import { SkillsPanel } from "../../../src/tui/panels/SkillsPanel";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SKILLS: readonly CodingSkillSummary[] = [
  {
    name: "answra-arch",
    description: "Agent 会话架构速查：进程拓扑、事件通道与状态所有权。",
    source: "workspace",
    directory: "D:/repo/.agents/skills/answra-arch",
  },
  {
    name: "resume-rewrite",
    description: "Rewrite a resume into a compact outline.",
    source: "builtin",
    directory: "C:/answra/dist/skills/resume-rewrite",
  },
];

describe("SkillsPanel", () => {
  it("groups skills by source and shows the focused skill details", async () => {
    const close = vi.fn();
    const instance = render(<SkillsPanel close={close} load={async () => ({ skills: SKILLS })} />);

    await vi.waitFor(() => expect(instance.lastFrame()).toContain("answra-arch"));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("项目 skill（1）");
    expect(frame).toContain("内置 skill（1）");
    expect(frame).toContain("D:/repo/.agents/skills/answra-arch");
    expect(frame).toContain("项目");
    const focusedLine = frame.split("\n").find((line) => line.includes("answra-arch"));
    expect(focusedLine).toContain(POINTER);

    instance.stdin.write("\u001b[B");
    await tick();
    expect(instance.lastFrame()).toContain("resume-rewrite · 内置");
    expect(instance.lastFrame()).toContain("Rewrite a resume into a compact outline.");

    instance.stdin.write("\u001b");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    instance.unmount();
  });

  it("keeps the focused row visible while scrolling", async () => {
    const skills = Array.from({ length: 16 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, "0")}`,
      description: `description ${index}`,
      source: "workspace" as const,
      directory: `D:/repo/.agents/skills/skill-${index}`,
    }));
    const instance = render(<SkillsPanel close={vi.fn()} load={async () => ({ skills })} />);

    await vi.waitFor(() => expect(instance.lastFrame()).toContain("↓ 10 more…"));
    for (let index = 0; index < 15; index += 1) {
      instance.stdin.write("\u001b[B");
      await tick();
    }

    expect(instance.lastFrame()).toContain("↑ 10 more…");
    expect(instance.lastFrame()).toContain("skill-15 · 项目");
    instance.unmount();
  });

  it("explains an empty catalog and reports load failures", async () => {
    const empty = render(<SkillsPanel close={vi.fn()} load={async () => ({ skills: [] })} />);
    await vi.waitFor(() => expect(empty.lastFrame()).toContain("没有发现可用 skill。"));
    expect(empty.lastFrame()).toContain(".agents/skills");
    empty.unmount();

    const failed = render(
      <SkillsPanel
        close={vi.fn()}
        load={async () => {
          throw new Error("skill 目录读取失败");
        }}
      />,
    );
    await vi.waitFor(() => expect(failed.lastFrame()).toContain("skill 目录读取失败"));
    failed.unmount();
  });
});
