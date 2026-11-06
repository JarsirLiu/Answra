# Shared Schemas

`@answra/shared/schema` is the runtime validation entrypoint for stable
cross-package contracts. A schema living here does not automatically make it a
durable domain event: the owning domain and persistence semantics must be
explicit. IPC channel names and request/response maps remain in `src/channels/`.

| File | Contract meaning | Does not own |
| --- | --- | --- |
| `stream.ts` | Agent-owned normalized model stream events, including text/reasoning/tool output and the retry notice projection | AI SDK provider types, run state transitions, renderer projection |
| `execution.ts` | Provider-neutral run/step status, retry facts and execution event envelope | Redis/durable adapter, retry algorithm, tenant authorization |
| `conversation.ts` | Conversation message/snapshot DTOs plus the current sequenced stream feed and change notifications | A durable domain event log, execution state machine, IPC channel names, renderer projection |

Ownership follows the facts: transcript belongs to Conversation/Session;
run/attempt lifecycle belongs to Execution; model deltas belong to Model Stream;
worker/IPC notifications belong to the transport boundary. Do not create a
generic event or status schema that combines these domains.

Use the package subpath `@answra/shared/schema`; consumers should not deep-import
these files. `index.ts` is the stable export surface.
