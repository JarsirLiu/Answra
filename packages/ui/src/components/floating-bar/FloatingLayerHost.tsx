import { Check, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import type { FloatingHostLayer } from "../../app/surfaceState";
import { ICON_SM } from "../../tokens";
import "./FloatingLayerHost.css";

interface FloatingLayerHostProps {
  layers: FloatingHostLayer[];
  onDismiss: (id: string) => void;
  onPermissionDecision?: (id: string, approved: boolean) => void;
}

/** Hosts transient notices and explicit permission decisions outside the panel slot. */
export function FloatingLayerHost({
  layers,
  onDismiss,
  onPermissionDecision,
}: FloatingLayerHostProps) {
  useEffect(() => {
    const timers = layers
      .filter((layer) => layer.kind === "notice" && layer.closePolicy === "auto")
      .map((layer) => window.setTimeout(() => onDismiss(layer.id), 6000));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [layers, onDismiss]);

  if (layers.length === 0) return null;
  return (
    <div aria-live="polite" className="floating-layer-host">
      {layers.map((layer) =>
        layer.kind === "notice" ? (
          <section className="floating-layer floating-notice" key={layer.id} role="alert">
            <TriangleAlert aria-hidden="true" size={ICON_SM} />
            <span className="floating-layer-message">{layer.message}</span>
            <button
              aria-label="关闭通知"
              className="floating-layer-close"
              onClick={() => onDismiss(layer.id)}
              type="button"
            >
              <X aria-hidden="true" size={ICON_SM} />
            </button>
          </section>
        ) : (
          <section className="floating-layer floating-permission" key={layer.id} role="dialog">
            <strong>{layer.title}</strong>
            <p>{layer.description}</p>
            <div className="floating-permission-actions">
              <button
                onClick={() => {
                  onPermissionDecision?.(layer.id, false);
                  onDismiss(layer.id);
                }}
                type="button"
              >
                {layer.cancelLabel}
              </button>
              <button
                onClick={() => {
                  onPermissionDecision?.(layer.id, true);
                  onDismiss(layer.id);
                }}
                type="button"
              >
                <Check aria-hidden="true" size={ICON_SM} />
                {layer.confirmLabel}
              </button>
            </div>
          </section>
        ),
      )}
    </div>
  );
}
