import type { BrowserWindow } from "electron";
import { setWindowCaptureProtection } from "./windowCaptureProtection";
import { isNonActivatingPlatform } from "./windowInteractionPolicy";

export type WindowRole = "main" | "reply-bar" | "ime-candidate" | "selection-overlay";
export type CaptureProtectionPolicy = "stealth-only" | "always" | "never";
export type WindowFocusEvent = {
  window: BrowserWindow;
  focused: boolean;
  visible: boolean;
};

export interface WindowSurfaceDescriptor {
  role: WindowRole;
  captureProtection: CaptureProtectionPolicy;
  failClosed?: boolean;
}

export interface WindowSurfaceRegistryOptions {
  applyCaptureProtection: (window: BrowserWindow, enabled: boolean) => boolean;
  onPolicyFailure?: (window: BrowserWindow, role: WindowRole) => void;
  platform?: NodeJS.Platform;
}

interface SurfacePolicy {
  alwaysOnTopLevel: "floating" | "pop-up-menu" | "screen-saver";
  nonActivating: boolean;
}

interface ManagedWindow {
  descriptor: WindowSurfaceDescriptor;
  onShow: () => void;
  onResize: () => void;
  onRestore: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onClosed: () => void;
}

const SURFACE_POLICIES: Record<WindowRole, SurfacePolicy> = {
  main: { alwaysOnTopLevel: "floating", nonActivating: false },
  "reply-bar": { alwaysOnTopLevel: "floating", nonActivating: false },
  "ime-candidate": { alwaysOnTopLevel: "pop-up-menu", nonActivating: true },
  "selection-overlay": { alwaysOnTopLevel: "screen-saver", nonActivating: true },
};

const DEFAULT_OPTIONS: WindowSurfaceRegistryOptions = {
  applyCaptureProtection: setWindowCaptureProtection,
};

/** Registers native surfaces and coordinates policies shared across their lifecycles. */
export function createWindowSurfaceRegistry(
  options: WindowSurfaceRegistryOptions = DEFAULT_OPTIONS,
) {
  const managed = new Map<BrowserWindow, ManagedWindow>();
  const ownerByChild = new Map<BrowserWindow, BrowserWindow>();
  const childByOwner = new Map<BrowserWindow, BrowserWindow>();
  const focusSubscribers = new Set<(event: WindowFocusEvent) => void>();
  let stealthEnabled = false;
  let focusedWindow: BrowserWindow | undefined;

  function register(window: BrowserWindow, descriptor: WindowSurfaceDescriptor): () => void {
    if (window.isDestroyed()) throw new Error("Cannot register a destroyed BrowserWindow");
    if (managed.has(window)) throw new Error(`BrowserWindow ${window.id} is already registered`);

    const entry: ManagedWindow = {
      descriptor,
      onShow: () => apply(window, "show", true),
      onResize: () => apply(window, "resize"),
      onRestore: () => apply(window, "restore", true),
      onFocus: () => {
        focusedWindow = window;
        publishFocus(window, true);
        const child = childByOwner.get(window);
        if (child) reconcileAbove(child, window);
      },
      onBlur: () => {
        if (focusedWindow === window) focusedWindow = undefined;
        publishFocus(window, false);
      },
      onClosed: () => unregister(window),
    };
    managed.set(window, entry);
    window.on("show", entry.onShow);
    window.on("resize", entry.onResize);
    window.on("restore", entry.onRestore);
    window.on("focus", entry.onFocus);
    window.on("blur", entry.onBlur);
    window.once("closed", entry.onClosed);
    apply(window, "register", true);

    return () => unregister(window);
  }

  function prepareToShow(window: BrowserWindow): boolean {
    const entry = managed.get(window);
    if (!entry || window.isDestroyed()) return false;
    return apply(window, "before-show", true);
  }

  function attachAbove(child: BrowserWindow, owner: BrowserWindow): void {
    const childEntry = managed.get(child);
    const ownerEntry = managed.get(owner);
    if (
      !childEntry ||
      !ownerEntry ||
      childEntry.descriptor.role !== "ime-candidate" ||
      (ownerEntry.descriptor.role !== "main" && ownerEntry.descriptor.role !== "reply-bar")
    ) {
      throw new Error("Only an IME candidate surface can attach above a main or reply-bar surface");
    }
    if (child.isDestroyed() || owner.isDestroyed()) return;

    const previousOwner = ownerByChild.get(child);
    if (previousOwner === owner) {
      reconcileAbove(child, owner);
      return;
    }
    if (previousOwner) {
      ownerByChild.delete(child);
      if (childByOwner.get(previousOwner) === child) childByOwner.delete(previousOwner);
      if (!child.isDestroyed()) child.setParentWindow(null);
    }

    const existingChild = childByOwner.get(owner);
    if (existingChild && existingChild !== child) detachOwner(existingChild);
    ownerByChild.set(child, owner);
    childByOwner.set(owner, child);
    child.setParentWindow(owner);
    reconcileAbove(child, owner);
  }

  function subscribeFocus(listener: (event: WindowFocusEvent) => void): () => void {
    focusSubscribers.add(listener);
    return () => focusSubscribers.delete(listener);
  }

  function setStealthEnabled(enabled: boolean): boolean {
    stealthEnabled = enabled;
    return applyAll("stealth-change");
  }

  function refresh(reason = "refresh"): boolean {
    return applyAll(reason);
  }

  function unregister(window: BrowserWindow): void {
    const entry = managed.get(window);
    if (!entry) return;
    detachOwner(window);
    const child = childByOwner.get(window);
    if (child) detachOwner(child);
    managed.delete(window);
    window.removeListener("show", entry.onShow);
    window.removeListener("resize", entry.onResize);
    window.removeListener("restore", entry.onRestore);
    window.removeListener("focus", entry.onFocus);
    window.removeListener("blur", entry.onBlur);
    window.removeListener("closed", entry.onClosed);
    if (focusedWindow === window) focusedWindow = undefined;
  }

  function detachOwner(child: BrowserWindow): void {
    const owner = ownerByChild.get(child);
    if (!owner) return;
    ownerByChild.delete(child);
    if (childByOwner.get(owner) === child) childByOwner.delete(owner);
    if (!child.isDestroyed()) child.setParentWindow(null);
  }

  function applyAll(reason: string): boolean {
    let succeeded = true;
    for (const window of managed.keys()) succeeded = apply(window, reason) && succeeded;
    return succeeded;
  }

  function apply(window: BrowserWindow, reason: string, reconcileSurface = false): boolean {
    const entry = managed.get(window);
    if (!entry || window.isDestroyed()) return false;
    if (reconcileSurface) applySurfacePolicy(window, entry.descriptor.role);
    return applyCapturePolicy(window, entry.descriptor, reason);
  }

  function applySurfacePolicy(window: BrowserWindow, role: WindowRole): void {
    if (window.isDestroyed()) return;
    const policy = SURFACE_POLICIES[role];
    window.setAlwaysOnTop(true, policy.alwaysOnTopLevel);
    if (policy.nonActivating && isNonActivatingPlatform(options.platform ?? process.platform))
      window.setFocusable(false);
  }

  function applyCapturePolicy(
    window: BrowserWindow,
    descriptor: WindowSurfaceDescriptor,
    reason: string,
  ): boolean {
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
    }
    return succeeded;
  }

  function reconcileAbove(child: BrowserWindow, owner: BrowserWindow): void {
    if (child.isDestroyed() || owner.isDestroyed() || ownerByChild.get(child) !== owner) return;
    child.setParentWindow(owner);
    applySurfacePolicy(child, "ime-candidate");
    // Windows 上 floating/pop-up-menu 两个 alwaysOnTop 层级都映射到同一
    // HWND_TOPMOST 带，setAlwaysOnTop 不会保证 owned 窗口排在 owner 之上；
    // 必须显式 moveAbove，否则候选窗口会被 owner 内的 DOM（发送按钮等）盖住。
    child.moveAbove(owner.getMediaSourceId());
  }

  function publishFocus(window: BrowserWindow, focused: boolean): void {
    const event = { window, focused, visible: !window.isDestroyed() && window.isVisible() };
    for (const listener of focusSubscribers) listener(event);
  }

  return {
    attachAbove,
    get focusedWindow() {
      return focusedWindow && !focusedWindow.isDestroyed() ? focusedWindow : undefined;
    },
    get size() {
      return managed.size;
    },
    prepareToShow,
    refresh,
    register,
    setStealthEnabled,
    subscribeFocus,
    unregister,
  };
}
