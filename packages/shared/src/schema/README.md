# Shared Schemas

`@answra/shared/schema` is the runtime validation entrypoint for stable
cross-package contracts. A schema living here does not automatically mean that
the current runtime persists it. IPC channel names and request/response maps
remain in `src/channels/`.

| File | Contract meaning | Does not own |
| --- | --- | --- |
| `events.ts` | The complete Agent event catalog, live and durable-candidate subsets, and the single `AgentEventEnvelope` | State transitions, durable adapter, UI projection |
| `status.ts` | Agent run/step status vocabulary, retry metadata and rebuildable snapshots | Event payloads, retry scheduling policy |
| `conversation.ts` | Conversation message and snapshot DTOs | Event catalog, event log, execution state machine, IPC channel names, renderer projection |

Use the package subpath `@answra/shared/schema`; consumers should not deep-import
these files. `index.ts` is the stable export surface.

## Agent event catalog

`events.ts` is the single source for all 31 event payload definitions. Its
runtime-validated catalog has 4 execution events and 27 normalized model stream
events:

- Execution lifecycle: `run-state-changed`, `step-started`, `step-finished`,
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

`AgentEvent` is the complete payload union. `AgentExecutionEvent` and
`AgentStreamEvent` are consumer subsets derived from the same definitions;
they do not introduce another event source. All are carried by
`AgentEventEnvelope`.

## Durable event eligibility

`AgentDurableEvent` explicitly lists the 28 event kinds eligible for a future
durable event adapter. `text-delta`, `reasoning-delta`, and `tool-input-delta`
remain live events and are excluded from that catalog. This is an eligibility
contract only: `apps/agent/src/execution/` currently owns an in-process store;
there is no durable adapter, event replay, or process recovery yet.

The durable event catalog does not reconstruct the full transcript by replaying
deltas. Conversation transcript persistence remains a separate concern. In
particular, the current `text-end` event carries a part ID, not the completed
text, so a future durable transcript must store its message content through the
Conversation data boundary.

`tool-call` records the model's request, `tool-execution-started` /
`tool-execution-finished` record the AI SDK tool executor callbacks, and
`tool-result` / `tool-error` record result parts from `fullStream`. They are
distinct facts and may all occur for one tool call. The AI SDK `raw` part and
provider metadata are intentionally excluded because they are not stable,
provider-neutral cross-package facts.
