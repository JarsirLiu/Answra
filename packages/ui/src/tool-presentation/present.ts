/** Single entry point: canonical tool name to a host-agnostic presentation. */
import { type CanonicalToolName, canonicalToolName } from "./registry";
import { presentEdit } from "./tools/edit";
import { presentFallback } from "./tools/fallback";
import { presentGrep } from "./tools/grep";
import { presentRead } from "./tools/read";
import { presentRunCommand } from "./tools/runCommand";
import { presentSkill } from "./tools/skill";
import { presentWebFetch } from "./tools/webFetch";
import { presentWebSearch } from "./tools/webSearch";
import type { ToolPresentation, ToolPresentationInput, ToolPresenterContext } from "./types";

type Presenter = (context: ToolPresenterContext) => ToolPresentation;

const PRESENTERS: Readonly<Record<CanonicalToolName, Presenter>> = {
  Read: presentRead,
  Grep: presentGrep,
  Edit: presentEdit,
  RunCommand: presentRunCommand,
  Skill: presentSkill,
  WebSearch: presentWebSearch,
  WebFetch: presentWebFetch,
};

export function presentToolCall(input: ToolPresentationInput): ToolPresentation {
  const canonical = canonicalToolName(input.toolName);
  if (canonical === undefined) return presentFallback(input);
  return PRESENTERS[canonical]({ ...input, canonicalName: canonical });
}
