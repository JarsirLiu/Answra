import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  interruptSignals,
  onProcessInterrupt,
  type ProcessSignalSource,
} from "../../src/transport/processSignals";

function createSource(): EventEmitter & ProcessSignalSource {
  return new EventEmitter() as EventEmitter & ProcessSignalSource;
}

describe("process signals", () => {
  it("uses POSIX signals on macOS", () => {
    expect(interruptSignals("darwin")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  it("uses Windows signals on win32", () => {
    expect(interruptSignals("win32")).toEqual(["SIGINT", "SIGTERM", "SIGBREAK"]);
  });

  it("fires the handler once and removes every listener on cleanup", () => {
    const source = createSource();
    const handler = vi.fn();
    const cleanup = onProcessInterrupt(handler, { platform: "darwin", source });

    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("SIGTERM")).toBe(1);
    expect(source.listenerCount("SIGHUP")).toBe(1);

    source.emit("SIGTERM");
    source.emit("SIGHUP");
    expect(handler).toHaveBeenCalledTimes(1);

    cleanup();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
    expect(source.listenerCount("SIGHUP")).toBe(0);
  });

  it("does not subscribe to POSIX-only SIGHUP on win32", () => {
    const source = createSource();
    const cleanup = onProcessInterrupt(vi.fn(), { platform: "win32", source });

    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("SIGTERM")).toBe(1);
    expect(source.listenerCount("SIGBREAK")).toBe(1);
    expect(source.listenerCount("SIGHUP")).toBe(0);

    cleanup();
  });
});
