import { lazy, type ReactNode, Suspense } from "react";
import type { Components } from "react-markdown";

const MarkdownRuntime = lazy(() =>
  import("./MarkdownRuntime").then((module) => ({ default: module.MarkdownRuntime })),
);

interface LazyMarkdownRuntimeProps {
  children: string;
  mode: "chat" | "safe-preview";
  components?: Components;
  fallback?: ReactNode;
}

export function LazyMarkdownRuntime({
  children,
  mode,
  components,
  fallback = null,
}: LazyMarkdownRuntimeProps) {
  return (
    <Suspense fallback={fallback}>
      <MarkdownRuntime components={components} mode={mode}>
        {children}
      </MarkdownRuntime>
    </Suspense>
  );
}
