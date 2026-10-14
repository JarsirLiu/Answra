import type { BrowserWindow } from "electron";
import { setWindowCaptureProtection } from "./windowCaptureProtection";

export type WindowRole = "main" | "reply-bar" | "ime-candidate" | "selection-overlay";
export type CaptureProtectionPolicy = "stealth-only" | "always" | "never";

export interface WindowPolicyDescriptor {
  role: WindowRole;
  captureProtection: CaptureProtectionPolicy;
  failClosed?: boolean;
}

export interface WindowPolicyRegistryOptions {
  applyCaptureProtection: (window: BrowserWindow, enabled: boolean) => boolean;
  onPolicyFailure?: (window: BrowserWindow, role: WindowRole) => void;
}

interface ManagedWindow {
  descriptor: WindowPolicyDescriptor;
  onShow: () => void;
  onResize: () => void;
  onRestore: () => void;
  onClosed: () => void;
}

const DEFAULT_OPTIONS: WindowPolicyRegistryOptions = {
  applyCaptureProtection: setWindowCaptureProtection,
};

/** Tracks shared native-window policy without taking ownership of window behavior. */
export function createWindowPolicyRegistry(options: WindowPolicyRegistryOptions = DEFAULT_OPTIONS) {
  const managed = new Map<BrowserWindow, ManagedWindow>();
  let stealthEnabled = false;

  function register(window: BrowserWindow, descriptor: WindowPolicyDescriptor): () => void {
    if (window.isDestroyed()) throw new Error("Cannot register a destroyed BrowserWindow");
    if (managed.has(window)) throw new Error(`BrowserWindow ${window.id} is already registered`);

    const entry: ManagedWindow = {
      descriptor,
      onShow: () => apply(window, "show"),
      onResize: () => apply(window, "resize"),
      onRestore: () => apply(window, "restore"),
      onClosed: () => unregister(window),
    };
    managed.set(window, entry);
    window.on("show", entry.onShow);
    window.on("resize", entry.onResize);
    window.on("restore", entry.onRestore);
    window.once("closed", entry.onClosed);
    apply(window, "register");

    return () => unregister(window);
  }

  function prepareToShow(window: BrowserWindow): boolean {
    return apply(window, "before-show");
  }

  function setStealthEnabled(enabled: boolean): boolean {
    stealthEnabled = enabled;
    return applyAll("stealth-change");
  }

  function refresh(reason = "refresh"): boolean {
    return applyAll(reason);
  }

  function applyAll(reason: string): boolean {
    let succeeded = true;
    for (const window of managed.keys()) succeeded = apply(window, reason) && succeeded;
    return succeeded;
  }

  function unregister(window: BrowserWindow): void {
    const entry = managed.get(window);
    if (!entry) return;
    managed.delete(window);
    window.removeListener("show", entry.onShow);
    window.removeListener("resize", entry.onResize);
    window.removeListener("restore", entry.onRestore);
    window.removeListener("closed", entry.onClosed);
  }

  function apply(window: BrowserWindow, reason: string): boolean {
    const entry = managed.get(window);
    if (!entry || window.isDestroyed()) return false;

    const { descriptor } = entry;
    const shouldProtect =
      descriptor.captureProtection === "always" ||
      (descriptor.captureProtection === "stealth-only" && stealthEnabled);
    const succeeded =
      descriptor.captureProtection === "never" ||
      options.applyCaptureProtection(window, shouldProtect);

    if (!succeeded) {
      console.warn("[window][policy] capture protection failed", {
        role: descriptor.role,
        windowId: window.id,
        reason,
        stealthEnabled,
        failClosed: descriptor.failClosed ?? false,
      });
      if (descriptor.failClosed) {
        window.hide();
        options.onPolicyFailure?.(window, descriptor.role);
      }
      return false;
    }

    return true;
  }

  return {
    get size() {
      return managed.size;
    },
    prepareToShow,
    refresh,
    register,
    setStealthEnabled,
    unregister,
  };
}
