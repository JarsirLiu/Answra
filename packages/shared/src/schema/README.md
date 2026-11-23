# Shared Schemas

`@answra/shared/schema` is the runtime validation entrypoint for stable
cross-package contracts. A schema living here does not automatically mean that
the current runtime persists it. IPC channel names and request/response maps
remain in `src/channels/`.

| File | Contract meaning | Does not own |
| --- | --- | --- |
| `events.ts` | The Agent event catalog plus its durable and live-only subsets | State transitions, persistence, UI projection |
| `status.ts` | Turn/step/compaction status vocabulary, retry metadata and rebuildable snapshots | Event payloads, retry scheduling policy |
| `session/frame.ts` | `SessionFrame` (durable transport carrying one settled item with `seq`) and `LiveFrame` (live-only transport without a cursor) | State transitions, persistence, subscription |
| `session/item.ts` | The append-only conversation item contract: kinds, terminal statuses, per-kind payloads and derived item ids | Write timing, `seq` allocation, migration, folding |
| `session/fold.ts` | The pure fold from `SessionItem[]` to `ConversationMessage[]`, shared by the agent snapshot loader and the desktop/CLI client | IO, Turn/Step state machine, domain policy |
| `session/summary.ts` | Session listing summary and page DTOs | Event catalog, persistence |
| `conversation.ts` | Conversation message and snapshot DTOs | Event catalog, event log, execution state machine, IPC channel names, renderer projection |
| `toolDisplay.ts` | Renderer-safe structured tool display payloads, currently `EditDiffDisplay` | Event payloads, tool execution, file reading, renderer projection |

Use the package subpath `@answra/shared/schema`; consumers should not deep-import
these files. `index.ts` is the stable export surface.

## Agent event catalog

`events.ts` is the single source for all event payload definitions. It covers
  session lifecycle and normalized model stream facts:

- Session lifecycle: `turn-queued`, `turn-started`,
  `turn-finished`, `turn-handoff`, `compaction-started`,
  `compaction-finished`, `compaction-failed`, `compaction-aborted`,
  `step-started`, `step-finished`, `context-usage-changed`,
  `part-state-changed`.
- Generation: `start`, `finish`, `abort`.
- Text: `text-start`, `text-delta`, `text-end`.
- Reasoning: `reasoning-start`, `reasoning-delta`, `reasoning-end`.
- Tool input and request: `tool-input-start`, `tool-input-delta`,
  `tool-input-end`, `tool-call`, `tool-approval-request`, `tool-output-denied`.
- Tool execution and result: `tool-execution-started`,
  `tool-execution-finished`, `tool-result`, `tool-error`.
- Model warnings: `model-warning-unsupported`, `model-warning-compatibility`,
  `model-warning-other`.
- Sources and generated content: `source-url`, `source-document`, `file`.
- Live-only notices: `retry`, `error`.

## Durable facts and live deltas

`AgentDurableEvent` lists the payloads that can settle into a durable item:
user-visible Turn/Step/compaction facts plus completed-value model events.
`AgentStreamEvent` is the normalized provider stream union; it includes live
deltas and completed model facts.

`AgentLiveOnlyEvent` lists the six live-only events: the four high-frequency
deltas (`text-delta`, `reasoning-delta`, `tool-input-delta`,
`tool-output-delta`) plus `retry` and `error`. They are carried by `LiveFrame`,
have no cursor and are never persisted.

Two channels therefore exist with separate guarantees:

| | `SessionFrame` | `LiveFrame` |
| --- | --- | --- |
| Payload | exactly one settled conversation item | a live delta or disposable notice |
| Cursor | `seq`, continuous per session | none |
| Replay | yes, by `seq` | never |
| Authority | single source of truth | optimistic preview, replaced by the settled item |

Session-level state (active Turn, context usage, compaction) travels in
`ConversationSnapshot`; there is no durable status frame.

`core/session/itemRecorder.ts` is the write path: it settles stream events into
items. `text-end` carries a part ID rather than the completed text, so the item
must be generated from the in-memory part after the event is applied.

`tool-call` records the model's request, `tool-execution-started` /
`tool-execution-finished` record the AI SDK tool executor callbacks, and
`tool-result` / `tool-error` record result parts from `fullStream`. They are
distinct facts and may all occur for one tool call. The AI SDK `raw` part and
provider metadata are intentionally excluded because they are not stable,
provider-neutral cross-package facts.
