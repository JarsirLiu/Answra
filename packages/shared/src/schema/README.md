# Shared Schemas

`@answra/shared/schema` is the runtime validation entrypoint for stable
cross-package contracts. A schema living here does not automatically mean that
the current runtime persists it. IPC channel names and request/response maps
remain in `src/channels/`.

| File | Contract meaning | Does not own |
| --- | --- | --- |
| `events.ts` | The Agent event catalog, durable-fact and live-only subsets, and `SessionEventEnvelope` (journal v1) | State transitions, durable adapter, UI projection |
| `status.ts` | Turn/step/compaction status vocabulary, retry metadata and rebuildable snapshots | Event payloads, retry scheduling policy |
| `session/frame.ts` | `SessionFrame` (durable transport with `seq`) and `LiveFrame` (live-only transport without a cursor), plus the v1 → v2 adapter | State transitions, journal persistence, subscription |
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
- Generation: `start`, `finish`, `abort`, `error`.
- Text: `text-start`, `text-delta`, `text-end`.
- Reasoning: `reasoning-start`, `reasoning-delta`, `reasoning-end`.
- Tool input and request: `tool-input-start`, `tool-input-delta`,
  `tool-input-end`, `tool-call`, `tool-approval-request`, `tool-output-denied`.
- Tool execution and result: `tool-execution-started`,
  `tool-execution-finished`, `tool-result`, `tool-error`.
- Model warnings: `model-warning-unsupported`, `model-warning-compatibility`,
  `model-warning-other`.
- Sources and generated content: `source-url`, `source-document`, `file`.
- Retry: `retry`.

`AgentDurableEvent` is the payload union that may enter the journal. `AgentStreamEvent`
is the normalized provider stream union; it includes live deltas and completed
model facts. `SessionEventEnvelope` is the journal row that carries durable facts.

## Durable facts and live deltas

`AgentDurableEvent` lists the payloads that may enter a journal and a
`SessionFrame`: user-visible Turn/Step/compaction facts plus completed-value
model events.

`AgentLiveOnlyEvent` lists the four high-frequency deltas (`text-delta`,
`reasoning-delta`, `tool-input-delta`, `tool-output-delta`). They are carried by
`LiveFrame`, have no cursor and are never persisted.

Two channels therefore exist with separate guarantees:

| | `SessionFrame` | `LiveFrame` |
| --- | --- | --- |
| Cursor | `seq`, continuous per session | none |
| Replay | yes, by `seq` | never |
| Authority | single source of truth | optimistic preview, overwritten by the full-value fact |

The connector rows live in `apps/agent/src/core/session/sqliteJournal.ts`; the
shared package only defines the vocabulary.

The durable event catalog does not reconstruct the full transcript by replaying
deltas. Conversation transcript persistence remains a separate concern. In
particular, the current `text-end` event carries a part ID, not the completed
text, so a durable transcript must store its message content through the
Conversation data boundary.

`tool-call` records the model's request, `tool-execution-started` /
`tool-execution-finished` record the AI SDK tool executor callbacks, and
`tool-result` / `tool-error` record result parts from `fullStream`. They are
distinct facts and may all occur for one tool call. The AI SDK `raw` part and
provider metadata are intentionally excluded because they are not stable,
provider-neutral cross-package facts.
