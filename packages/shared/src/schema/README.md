# Shared Schemas

`@answra/shared/schema` is the runtime validation entrypoint for stable Agent
domain contracts. Some of these values are later delivered over IPC, but IPC
channel names and request/response maps remain in `src/channels/`.

| File | Owns | Does not own |
| --- | --- | --- |
| `stream.ts` | Model output stream events: text, reasoning, tools, sources, retries, and errors | AI SDK provider types, execution state, UI state |
| `execution.ts` | Run/step lifecycle, terminal outcomes, token usage, and event-store envelopes | Redis implementation, retry algorithms, tenant authorization |
| `conversation.ts` | Conversation messages, snapshots, journal events, and change feed | Model execution internals, IPC channel names, renderer projections |

Use the package subpath `@answra/shared/schema`; consumers should not deep-import
these files. `index.ts` is the stable export surface.
