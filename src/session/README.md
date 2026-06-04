# src/session/

**Last updated: 2026-05-16**

Owns the singleton Chrome process, the CDP client, pause state, and the buffered console + network streams. Every tool reads from this layer.

## Files

| File | Exports | Role |
|---|---|---|
| `state.ts` | `sessionState` (singleton), `SessionState`, `requireSession()`, `requirePaused()`, `getSession()`, `ROOT_SESSION_KEY`, `BreakpointRecord`, `BreakpointBinding` | The singleton holding everything else (CDP client, Chrome process, breakpoints map, `ScriptStore`, `PauseTracker`, ring buffers, per-session handler refs, `pauseOnExceptions` policy). The `sessionState.client` field is the injection seam L2 contract tests use to swap in `test/fake-cdp.ts`. |
| `browser.ts` | `launchChrome()`, `attachChrome()`, `closeSession()`, `switchTarget()` | Lifecycle. `chrome-launcher` for `launch_chrome`; `CDP({port,host})` for `attach_chrome`. Sets up `Target.setAutoAttach({ flatten: true })` so workers + iframes hit the same CRI client tagged with their own `sessionId`. |
| `pause.ts` | `PauseTracker`, `PauseState` | One pause at a time. `waitForPause(timeout)` blocks until the next `Debugger.paused`; `waitForPauseOrResume(timeout)` is the step-tool variant. **Read the entry-guard comment on `waitForPauseOrResume`** — it is load-bearing for fast steps where CRI delivers the step response and the next pause in the same WebSocket batch. |
| `buffers.ts` | `RingBuffer<T>`, `ConsoleEntry`, `NetworkEntry` | Capped at 1000 entries each, monotonic `seq` for pagination. `RingBuffer.update()` is used by the network buffer when a response arrives for an in-flight request. |

## Session lifecycle

```mermaid
stateDiagram-v2
    [*] --> Disconnected
    Disconnected --> Launching: launch_chrome
    Disconnected --> Attaching: attach_chrome
    Launching --> Running: launched + CRI connected
    Attaching --> Running: CRI connected
    Running --> Paused: Debugger.paused
    Paused --> Running: resume / step_*
    Running --> Closed: close_session
    Paused --> Closed: close_session
    Closed --> Disconnected: SessionState.reset()
```

`closeSession()` kills Chrome only if we launched it ourselves (`sessionState.attached === false`); an `attach_chrome` session leaves the user's Chrome alive.

## Public surface tools rely on

- `requireSession(): SessionState` — throws `noSession()` if no client. Use in every tool.
- `requirePaused(): SessionState` — also throws `notPaused()`. Use for `get_scope`, `get_call_stack`, `evaluate` (with `frame_index`), and the step tools.
- `sessionState.client!.send(method, params, sessionId?)` — direct CDP call. **Always** pass through the `sessionId` that came from the source (script, frame, request) — see the provenance gotcha below.
- `sessionState.pause.current()` / `.isPaused()` — current pause state.
- `sessionState.scripts` (`ScriptStore`) — see [../sourcemap/README.md](../sourcemap/README.md).
- `sessionState.console.query({since, filter, limit})` and `sessionState.network.query(...)` — paginated reads; the `cursor` returned to callers is the max `seq` seen.

## Gotchas

- **`session_id` provenance.** `objectId`, `callFrameId`, `requestId`, and `scriptId` are all **per-Debugger/Runtime/Network agent** — i.e., per flat session. Two iframes can both emit `requestId="123"`. Every tool that returns one of these IDs also returns the originating `session_id` (`null` for root). Round-trip it on follow-ups or the call hits the wrong session. There is no "fall back to active pause session" behavior — omitting `session_id` always means root.
- **Pause race on fast steps.** See `pause.ts` `waitForPauseOrResume` comment — CRI emits events synchronously, so for a fast step the next `Debugger.paused` arrives before the step caller registers its waiter. The entry guard handles this; do not "simplify" it.
- **Auto-attach replay.** Newly-attached child sessions (worker, OOPIF) inherit `pauseOnExceptions` via the `set_pause_on_exceptions` replay path. Don't add per-session state without considering the replay surface.
- More depth → [../../docs/test-eval-plan.md](../../docs/test-eval-plan.md) §Critical gotchas (pause races, auto-attach replay, root↔child collision routing).
