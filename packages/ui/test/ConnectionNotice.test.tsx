import type { AgentConnectionState } from "@answra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionNotice } from "../src/components/chat/ConnectionNotice";

const base = {
  target: "agent-service" as const,
  revision: 1,
  updatedAt: 1_000,
  maxAttempts: 5,
};

function state(overrides: Partial<AgentConnectionState>): AgentConnectionState {
  return { ...base, attempt: 1, ...overrides } as AgentConnectionState;
}

describe("ConnectionNotice", () => {
  it("shows the retry counter while reconnecting", () => {
    render(
      <ConnectionNotice
        state={state({
          status: "reconnecting",
          attempt: 3,
          nextRetryAt: 2_000,
          reason: "readiness-timeout",
        })}
      />,
    );

    expect(screen.getByText("网络连接中断，正在重连 3/5")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "reconnecting");
  });

  it("shows the terminal unavailable state without a manual retry action", () => {
    render(
      <ConnectionNotice
        state={state({ status: "unavailable", attempt: 5, reason: "worker-exit" })}
      />,
    );

    expect(screen.getByText("网络不可用，请检查网络后继续")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveAttribute("data-status", "unavailable");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays hidden while connecting or connected", () => {
    const view = render(<ConnectionNotice state={state({ status: "connecting" })} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(
      <ConnectionNotice state={state({ status: "connected", attempt: 1, connectedAt: 1_100 })} />,
    );
    expect(view.container).toBeEmptyDOMElement();
  });
});
