/**
 * Mirror the window-local stealth state onto <html> so body portals stay in scope.
 *
 * Cursor hiding lives in styles/base.css. Scoping it to the app root leaves
 * portals mounted under document.body unguarded, so the document element is the
 * only stable boundary shared by every renderer and portal.
 */
import { useEffect } from "react";

export function useStealthDocumentFlag(enabled: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!enabled) {
      delete root.dataset.stealth;
      return;
    }
    root.dataset.stealth = "true";
    return () => {
      delete root.dataset.stealth;
    };
  }, [enabled]);
}
