import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { TUI_THEME } from "../../../src/tui/chrome/theme";
import { NotificationLine, notificationToneColor } from "../../../src/tui/notices/NotificationLine";

describe("NotificationLine", () => {
  it("renders nothing without a notification", () => {
    const instance = render(<NotificationLine notification={null} />);
    expect(instance.lastFrame()).toBe("");
    instance.unmount();
  });

  it("renders the current notification text", () => {
    const instance = render(
      <NotificationLine notification={{ key: "test", text: "正在连接", tone: "info" }} />,
    );
    expect(instance.lastFrame()).toContain("正在连接");
    instance.unmount();
  });
});

describe("notificationToneColor", () => {
  it("maps every tone to the shared theme", () => {
    expect(notificationToneColor("success")).toBe(TUI_THEME.success);
    expect(notificationToneColor("warning")).toBe(TUI_THEME.warning);
    expect(notificationToneColor("error")).toBe(TUI_THEME.error);
  });

  it("leaves info dim instead of colored", () => {
    expect(notificationToneColor("info")).toBeUndefined();
    expect(notificationToneColor(undefined)).toBeUndefined();
  });
});
