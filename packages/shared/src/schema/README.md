# Shared Schemas

`@answra/shared/schema` is the runtime validation entrypoint for stable
cross-package contracts. A schema living here does not automatically make it a
durable domain event: the owning domain and persistence semantics must be
explicit. IPC channel names and request/response maps remain in `src/channels/`.

| File | Contract meaning | Does not own |
| --- | --- | --- |
| `stream.ts` | Agent-owned normalized model stream events, including text/reasoning/tool output and the retry notice projection | AI SDK provider types, run state transitions, renderer projection |
| `status.ts` | Agent run/step status vocabulary, retry metadata and rebuildable snapshots | Event payloads, retry scheduling policy |
| `events.ts` | The single `AgentEventEnvelope` carrying existing execution and stream event names | Durable adapter, retry algorithm, tenant authorization |
| `conversation.ts` | Conversation message and snapshot DTOs | Event payloads, event log, execution state machine, IPC channel names, renderer projection |

Ownership follows the facts: transcript belongs to Conversation/Session;
run/attempt lifecycle and model deltas are carried by one Agent event envelope;
runtime status is rebuilt from those facts. Do not add a second event log.

Use the package subpath `@answra/shared/schema`; consumers should not deep-import
these files. `index.ts` is the stable export surface.
