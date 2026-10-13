/**
 * Window interaction policy is separate from capture protection.
 *
 * On Windows, a window can receive mouse input without becoming the
 * foreground window when it is made non-focusable (WS_EX_NOACTIVATE). This is
 * safe for surfaces such as the screenshot selection overlay, which do not
 * need keyboard focus. Text-input surfaces must opt out until a native
 * keyboard forwarding channel is available.
 */

export interface NonActivatingWindowLike {
  isDestroyed(): boolean;
  setFocusable(focusable: boolean): void;
  on(event: "blur" | "hide", listener: () => void): unknown;
}

export type WindowInteractionReason =
  | "unsupported-platform"
  | "destroyed"
  | "keyboard-channel-required"
  | "applied";

export interface WindowInteractionResult {
  applied: boolean;
  reason: WindowInteractionReason;
}

export interface NonActivatingOptions {
  /** Whether the surface needs a native keyboard forwarding channel. */
  requiresKeyboardChannel?: boolean;
  /** Whether the required keyboard forwarding channel is currently usable. */
  keyboardChannelAvailable?: boolean;
}

const managedWindows = new WeakSet<object>();

export function isNonActivatingPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Applies the Windows no-activate policy before the window is shown.
 *
 * A text surface is deliberately left focusable when its keyboard channel is
 * unavailable. Keeping input usable is safer than silently creating a dead
 * editor. The listener reasserts the policy if another lifecycle path flips
 * focusability back on.
 */
export function attachNonActivatingWindow(
  window: NonActivatingWindowLike | null | undefined,
  options: NonActivatingOptions = {},
  platform: NodeJS.Platform = process.platform,
): WindowInteractionResult {
  if (!isNonActivatingPlatform(platform)) {
    return { applied: false, reason: "unsupported-platform" };
  }
  if (!window || window.isDestroyed()) {
    return { applied: false, reason: "destroyed" };
  }
  if (options.requiresKeyboardChannel && !options.keyboardChannelAvailable) {
    return { applied: false, reason: "keyboard-channel-required" };
  }

  managedWindows.add(window);
  window.setFocusable(false);
  const restore = () => {
    if (!window.isDestroyed()) window.setFocusable(false);
  };
  window.on("blur", restore);
  window.on("hide", restore);
  return { applied: true, reason: "applied" };
}

export function isNonActivatingWindow(window: object | null | undefined): boolean {
  return !!window && managedWindows.has(window);
}
