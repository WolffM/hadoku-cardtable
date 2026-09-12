# P4 — Ask registry: a durable, seat-scoped request/response over the room

**Status:** proposal to upstream (watchparty room module).
**Licence posture:** this document, and the packages it specifies, are MIT. It was
written clean-room from the requirement and from upstream's own §3.4 text. See D12.
**Scope:** design only. No implementation, no package layout, no code beyond the type
signatures below.

---

## 1. The requirement, in our words

A server-side caller — the draft director, the rules driver, a table action — needs to
put a question to **one seated participant** and `await` the answer, while everything
else in the room keeps running. "Pick a card." "Choose a target." "Mulligan?"

What that has to survive, stated as obligations:

1. **Correlation.** Every ask carries an id that is unique within the room and
   **monotonically increasing**. The answer is matched to the question by that id and
   by nothing else.
2. **Transport loss.** The participant's socket dropping does **not** settle the ask. It
   stays pending.
3. **Replay.** When the participant attaches a socket again, every still-pending ask is
   re-sent to them, unchanged, in issue order.
4. **Queue, don't fail.** An ask issued while the participant has *no* live socket is
   accepted and held. It is not an error, and it is not lost. It is sent the moment a
   socket appears.
5. **Declared timeout fallback.** A timeout resolves with a **value the caller supplied
   up front**, or rejects — the caller chooses which, and "resolve" always has a
   concrete value attached. There is no implicit default.
6. **Cancellable.** The caller can abort an in-flight ask.
7. **Seat-scoped lifetime.** An ask is cancelled when the participant **leaves the
   seat** — not when a socket drops. A mid-draft refresh must not settle anything.
8. **Unknown ids are dropped and counted.** A reply bearing a correlation id that is not
   pending for the replying participant is discarded, a counter goes up, and **nothing
   throws** — not into the caller's promise, not out of the transport handler.

The distinction under all of this: **participants and seats are durable, sockets are
not.** The ask registry is keyed to the durable things.

---

## 2. State machine

Five states. Three are terminal.

```
                         ┌──────────────────────────────┐
                         │                              │
   issue()               ▼        attach (first socket)  │
  ──────────►  [ISSUED] ───► [QUEUED] ────────────────►[DELIVERED]
                    │            ▲                     │  │  ▲
                    │            │  last socket drops  │  │  │ attach (extra socket)
                    └────────────┼─────────────────────┘  └──┘  → re-emit, no state change
                  (has a socket) │
                                 │
        ┌────────────────────────┴───────────────────────┐
        │                                                │
        ▼                    ▼                    ▼      ▼
   [REPLIED]            [TIMED-OUT]          [CANCELLED]
   (terminal)            (terminal)           (terminal)
```

### 2.1 States

| State | Meaning | Observable |
| --- | --- | --- |
| `issued` | Id allocated, promise created, deadline armed. A bookkeeping instant, not a resting state — every ask leaves it within the same tick. | `stats().issued` |
| `queued` | Pending; the target participant currently has **zero** live sockets. The envelope is held. | `stats().queued` gauge, `pending()` |
| `delivered` | Pending; the envelope has been written to at least one of the target's live sockets. | `stats().delivered` counter, `pending()` |
| `replied` | Terminal. Promise resolved with the reply value. | `stats().replied` |
| `timedOut` | Terminal. Deadline passed; promise resolved with `onTimeout.value` or rejected with `AskTimeoutError`. | `stats().timedOut` |
| `cancelled` | Terminal. Promise rejected with `AskCancelledError`. | `stats().cancelled` |

### 2.2 Legal transitions

| # | From → To | Trigger | Notes |
| --- | --- | --- | --- |
| T1 | `issued` → `delivered` | Target is seated and has ≥1 live socket at issue time. Envelope written to **all** of their live sockets. | Same tick as `issue()`. |
| T2 | `issued` → `queued` | Target is seated and has **0** live sockets. | Not an error. Requirement 4. |
| T3 | `delivered` → `queued` | The target's socket set becomes empty. | Requirement 2. The **only** effect of a socket drop. |
| T4 | `queued` → `delivered` | The target's socket set becomes non-empty. Every pending ask for that participant is re-emitted in ascending `askId` order. | Requirement 3. |
| T5 | `delivered` → `delivered` | The target attaches an **additional** socket while already delivered. The same envelope — same `askId`, byte-identical payload — is written to the new socket. | Self-loop. Idempotent; see §2.4. |
| T6 | `queued` \| `delivered` → `replied` | A reply arrives from the **target participant** bearing this `askId`. | First valid reply wins. |
| T7 | `queued` \| `delivered` → `timedOut` | The deadline passes. | A never-delivered ask can time out straight out of `queued`. |
| T8 | `queued` \| `delivered` → `cancelled` | `opts.signal` aborts (`reason: 'signal'`), **or** the target participant leaves the seat (`reason: 'seat-exit'`), **or** the room closes (`reason: 'room-closed'`). | Requirement 6, 7. |

### 2.3 Illegal transitions — each must be provably a no-op

- **Any transition out of a terminal state.** A late reply, a late timer, a late abort,
  a late seat-exit against a settled ask changes nothing and never throws.
- **`delivered` → `cancelled` on socket drop.** Socket loss is T3 and only T3.
- **`queued` → `replied` from a participant who is not the target.** That is an unknown
  id (§2.5), not a reply.
- **Id reuse.** An `askId` that has settled is never allocated again in this room.

### 2.4 What is idempotent

| Operation | Idempotence guarantee |
| --- | --- |
| **Replay** (T4, T5) | Re-emitting a pending envelope is a pure send. It does not re-arm the deadline, does not allocate a new `askId`, does not mutate the payload. Replaying `n` times and replaying once are indistinguishable to the caller. Only `stats().delivered` (an emit counter) advances. |
| **Settling** | Exactly once per ask. The promise is settled by whichever of T6/T7/T8 arrives first; every later attempt is a no-op. |
| **Cancel** | `cancel(askId)` on an already-settled ask returns `false` and does nothing. On a pending ask it returns `true`. Safe to call repeatedly. |
| **Seat-exit sweep** | Cancelling "all asks for this participant" is a set operation. Running it twice cancels the same set once. |
| **Detach/attach** | A socket detaching that is already gone, or attaching that is already present, does not move any ask's state. |

### 2.5 The unknown-id rule, precisely

A reply is *matched* only if **all** of these hold:

1. `askId` is currently pending in this room, **and**
2. the replying participant is that ask's resolved target participant.

If either fails — an id that never existed, an id that already settled, a second reply
to the same id, a valid id replied to by the wrong participant, an id from a previous
room — the reply is **discarded**, `stats().droppedUnknownReplies` increments by exactly
one, and the call returns normally. No throw reaches the transport handler and no
caller's promise is disturbed.

---

## 3. Surface

Refined from upstream's §3.4 signature. The shape of `ask` is theirs; the additions are
the registry and the error types the requirement forces into the open.

### 3.1 `room.ask`

```ts
room.ask<T>(
  target: ParticipantId | SeatId,
  kind: string,
  payload: unknown,
  opts: {
    timeoutMs: number;
    onTimeout: { mode: 'value'; value: T } | { mode: 'throw' };
    signal?: AbortSignal;
  },
): Promise<T>
```

Unchanged from upstream. Committed semantics on top of it:

- **Target resolution happens once, at issue time.** A `SeatId` resolves to whoever
  occupies that seat at that instant; the ask is then bound to that **participant** for
  its whole life. If the seat's occupant changes, the ask is cancelled by T8
  (`seat-exit`) — it does not silently transfer to the new occupant.
- **An unseated target rejects at issue** with `AskNotSeatedError`. The ask never enters
  the machine, allocates no `askId`, and does **not** touch
  `droppedUnknownReplies`. (Requirement: "ask one seated participant".)
- **`timeoutMs` is wall-clock from issue** and does not pause while `queued`. See §5 for
  the trade and the alternative.
- **`kind` is opaque to the room.** It is echoed on the wire so the client can route.
- **The raw `ParticipantId` never goes on the wire** (D11). The envelope carries no
  target field — it is delivered to that participant's sockets, which is the addressing.

### 3.2 Wire envelopes

Two shapes, both minimal. `askId` is the only join key.

```ts
type AskId = number & { readonly __brand: 'AskId' };

// server → the target participant's sockets
type AskEnvelope = { askId: AskId; kind: string; payload: unknown };

// any of that participant's sockets → server
type AskReply = { askId: AskId; value: unknown };
```

`AskId` is allocated from a **per-room counter starting at 1 and incrementing by
exactly 1**. Strictly increasing over the room's lifetime, never reused, never reset by
a reconnect. Monotonicity is a public, testable guarantee — not an accident of the
allocator.

### 3.3 The registry

```ts
room.asks: {
  /** Snapshot of everything not yet settled, in ascending askId order. */
  pending(): ReadonlyArray<{
    askId: AskId;
    kind: string;
    target: ParticipantId;
    seat: SeatId | null;
    state: 'queued' | 'delivered';
    issuedAt: number;      // epoch ms
    deadlineAt: number;    // epoch ms
    emitCount: number;     // how many times the envelope has been written to a socket
  }>;

  /** Monotonic counters + gauges. Never reset. */
  stats(): {
    issued: number;
    delivered: number;                // emit count, not ask count (replays advance it)
    queued: number;                   // gauge: currently in `queued`
    replied: number;
    timedOut: number;
    cancelled: number;
    droppedUnknownReplies: number;    // requirement 8
  };

  /** Cancel one pending ask. `true` if it was pending and is now cancelled. */
  cancel(askId: AskId, reason?: string): boolean;

  /** Ingress used by the transport adapter and by tests. Never throws. */
  submitReply(from: ParticipantId, reply: AskReply): 'matched' | 'dropped';
};
```

`submitReply` is the seam that makes requirement 8 testable without a socket: it is the
one function that can return `'dropped'`, and its `'dropped'` return and the
`droppedUnknownReplies` counter must move together, always.

### 3.4 Errors

```ts
class AskTimeoutError   extends Error { askId: AskId; timeoutMs: number }
class AskCancelledError extends Error { askId: AskId; reason: 'signal' | 'seat-exit' | 'room-closed' | string }
class AskNotSeatedError extends Error { target: ParticipantId | SeatId }
```

`onTimeout: { mode: 'value' }` **resolves**; `{ mode: 'throw' }` rejects with
`AskTimeoutError`. Cancellation **always** rejects — there is no cancel-with-value mode,
because a cancelled question has no answer to stand in for.

---

## 4. Tests that prove it

Every one of these is writable as a failing test today against the surface in §3. Timers
are driven by a fake clock; sockets by a stub transport with explicit `attach`/`detach`.

### 4.1 Required

**A-1 — an ask that times out returns the declared value.**
> Seat participant `P` with one live socket. Issue
> `ask<'pass'>(P, 'pick', {...}, { timeoutMs: 5_000, onTimeout: { mode: 'value', value: 'pass' } })`.
> Advance the clock 5_000 ms with no reply. **Assert:** the promise *resolves* (does not
> reject) with exactly `'pass'`; `stats().timedOut === 1`; `stats().replied === 0`;
> `pending()` is empty.

**A-2 — an ask replayed after reconnect resolves.**
> Seat `P` with socket `s1`. Issue an ask; assert the envelope reached `s1` and
> `pending()[0].state === 'delivered'`. Detach `s1`; assert state is `'queued'`, the
> promise is still pending, and `stats().cancelled === 0`. Attach `s2` **for the same
> participant**; assert `s2` received an envelope with the *same* `askId` and a payload
> deep-equal to the original. `submitReply(P, { askId, value: 42 })`. **Assert:** the
> original promise resolves with `42`; `stats().replied === 1`.

**A-3 — an ask cancelled by seat-exit rejects.**
> Seat `P`, issue an ask, leave it pending. Remove `P` from the seat. **Assert:** the
> promise rejects with `AskCancelledError` and `reason === 'seat-exit'`;
> `stats().cancelled === 1`; `pending()` is empty. Then
> `submitReply(P, { askId, value: 1 })` **assert:** returns `'dropped'` and
> `droppedUnknownReplies === 1` — the late reply is not an error.

**A-4 — an unknown correlation id increments a counter and resolves nothing.**
> Seat `P`, issue one ask (`askId = n`). Call
> `submitReply(P, { askId: (n + 999) as AskId, value: 'x' })`. **Assert:** the call
> returns `'dropped'` and does **not** throw; `stats().droppedUnknownReplies === 1`; the
> outstanding promise is still pending; `stats().replied === 0`; `pending()` still has
> exactly one entry with `askId === n`.

### 4.2 Added, because the requirement implies them

**A-5 — correlation ids are monotonic.**
> Issue five asks across two participants, interleaved with a detach and an attach.
> **Assert:** the five `askId`s are strictly increasing, and the reconnect did not reset
> or reuse any.

**A-6 — an ask issued with no live socket queues rather than failing.**
> Seat `P` with zero sockets. Issue an ask. **Assert:** `ask()` does not throw and the
> promise is pending; `pending()[0].state === 'queued'`; `emitCount === 0`. Attach a
> socket. **Assert:** the envelope arrives, state is `'delivered'`, `emitCount === 1`.

**A-7 — an ask can time out while queued.**
> Seat `P` with zero sockets. Issue with `timeoutMs: 1_000`, `onTimeout: { mode: 'value',
> value: null }`. Advance 1_000 ms without ever attaching. **Assert:** resolves with
> `null`; `timedOut === 1`; `pending()` empty. Then attach a socket. **Assert:** the new
> socket receives **no** envelope for that `askId`.

**A-8 — `onTimeout: { mode: 'throw' }` rejects.**
> Same as A-1 but `{ mode: 'throw' }`. **Assert:** rejects with `AskTimeoutError` whose
> `askId` matches and `timeoutMs === 5_000`.

**A-9 — abort signal rejects with `reason: 'signal'`.**
> Issue with an `AbortController`'s signal. Abort. **Assert:** rejects with
> `AskCancelledError`, `reason === 'signal'`, `stats().cancelled === 1`. Abort again.
> **Assert:** no second rejection, `cancelled` still `1`.

**A-10 — a socket drop on its own settles nothing.**
> Issue; detach the only socket; advance the clock to just **under** the deadline.
> **Assert:** promise still pending; `cancelled === 0`; `timedOut === 0`;
> `state === 'queued'`.

**A-11 — a second reply to the same id is dropped and counted.**
> Issue, reply once (resolves), then `submitReply` the same `askId` again. **Assert:**
> returns `'dropped'`; `droppedUnknownReplies === 1`; `replied` still `1`; the promise's
> resolved value is unchanged.

**A-12 — a reply from the wrong participant is dropped and counted.**
> Seat `P` and `Q`. Issue an ask to `P` (`askId = n`). Call
> `submitReply(Q, { askId: n, value: 'stolen' })`. **Assert:** returns `'dropped'`;
> `droppedUnknownReplies === 1`; `P`'s ask still pending. Then `submitReply(P, ...)`
> resolves it.

**A-13 — replay order is issue order.**
> With `P` holding no socket, issue three asks. Attach one socket. **Assert:** the socket
> received exactly three envelopes, in ascending `askId` order, payloads matching.

**A-14 — an extra socket gets the same envelope, and the ask does not re-arm.**
> Issue to `P` on `s1` at t=0 with `timeoutMs: 1_000`. At t=600 attach `s2`. **Assert:**
> `s2` received the same `askId` and payload; `emitCount === 2`; state still
> `'delivered'`; `deadlineAt` unchanged. At t=1_000 the ask times out — the second
> delivery did **not** buy another 1_000 ms.

**A-15 — an unseated target rejects at issue and pollutes no counter.**
> Target a `ParticipantId` who is connected but holds no seat. **Assert:** rejects with
> `AskNotSeatedError`; `stats().issued === 0`; `droppedUnknownReplies === 0`;
> `pending()` empty.

**A-16 — a `SeatId` ask binds to the occupant at issue time.**
> `P` occupies seat `s`. Issue `ask(s, ...)`. Swap the seat's occupant to `Q`.
> **Assert:** the promise rejects with `reason === 'seat-exit'`; a subsequent
> `submitReply(Q, { askId, ... })` returns `'dropped'` and increments the counter.

**A-17 — counters and the `'dropped'` return never disagree.**
> Property-style: run a randomised sequence of issues, replies (valid and bogus),
> detaches, attaches, timeouts and seat-exits. **Assert** after every step that
> `issued === replied + timedOut + cancelled + pending().length`, and that the number of
> `submitReply` calls returning `'dropped'` equals `droppedUnknownReplies`.

---

## 5. What we give up if upstream says no

Ordered by how much it costs us. For each: the fallback we can live with, and the one we
cannot.

| # | Ask | If refused, we lose | Our fallback | Cost |
| --- | --- | --- | --- | --- |
| 1 | **`room.asks.stats().droppedUnknownReplies`** | The only evidence that a client is replaying stale ids. Requirement 8 says "counted"; without a counter the requirement is untestable and A-4 cannot be written. | Wrap `ask` in our own registry that shadows every id and counts drops before handing off. | Ugly and racy — we would be counting on the outside of the thing that decides. **This is the one we would push hardest on.** |
| 2 | **`room.asks.submitReply` as a public seam** | The ability to test requirement 8 without a live socket. | Drive a stub socket in tests. | Tolerable. Slower, noisier tests; the drop path becomes harder to exercise exhaustively. |
| 3 | **`AskNotSeatedError` at issue** | A loud failure when we ask a ghost. | Check `seatOf(target)` ourselves before every `ask`. | Tolerable, but it is a check every caller must remember, which means one caller eventually will not. |
| 4 | **Wall-clock deadline from issue** (upstream may prefer the timer to *pause* while queued) | Predictable pick timers. A paused timer means a participant who never returns holds a pending ask until seat-exit. | Accept the paused-timer semantics and add our own outer deadline per ask. | Acceptable. Both are defensible; we just need to know **which**, in writing, because A-7 asserts one of them. If upstream picks pausing, A-7 inverts: "advance past the deadline while queued → still pending". |
| 5 | **FIFO replay order** (A-13) | Deterministic replay for a queue of picks. | Sort on our side by embedding a sequence number in `payload`. | Annoying but survivable. |
| 6 | **`SeatId` as a target** | The convenience of asking "whoever is in seat 3". | Resolve the seat to a `ParticipantId` ourselves at call time. | Cheap. Same semantics, one extra line. |
| 7 | **`pending()` with `emitCount` / `deadlineAt`** | Observability, and A-14's assertion that a replay does not re-arm the deadline. | Assert the re-arm behaviour indirectly via the fake clock. | Cheap for tests, real loss for debugging a live draft. |

**Non-negotiable from our side** — if any of these are refused, the room module does not
meet our need and we hold the asks ourselves on top of a raw send/receive:

- Pending asks are **not** settled by socket loss.
- Pending asks **replay** on re-attach.
- Asks issued with no live socket **queue** rather than throw.
- Cancellation is bound to **seat exit**, not socket lifetime.
- A timeout resolution carries a **caller-supplied value**.
- An unknown correlation id **never throws**.

---

## 6. Judgement calls made where the requirement was silent

1. **The deadline runs on wall-clock from issue and does not pause while queued.** The
   requirement says asks queue and asks time out, but not how the two interact. We chose
   the version where a draft's pick timer means what it says. Flagged as trade #4 above —
   we will take the other semantics if upstream prefers, but it must be written down.
2. **An unseated target is an error, not a queue.** "Ask one seated participant" reads as
   a precondition, and queueing for a seat someone might take later would let an ask
   outlive the question. Rejects with `AskNotSeatedError`.
3. **A `SeatId` target binds to the occupant at issue, and an occupant swap cancels.**
   The alternative — re-target the new occupant — would hand one player's hidden-state
   question to another player. Not acceptable at a card table.
4. **A reply from the wrong participant is an unknown id, not an auth error.** Same
   handling: dropped, counted, silent. Making it throw would give a client a way to make
   the server noisy.
5. **Cancellation always rejects**, including abort — no cancel-with-value mode, by
   symmetry with the fact that a cancelled question has no answer.
6. **`stats().delivered` counts emits, not asks** (replays advance it) while
   `stats().queued` is a gauge. Mixing counters and gauges in one object is a small wart;
   the alternative was two objects. Documented rather than hidden.
7. **Not specified here, deliberately:** any cap on pending asks per participant. It is a
   real question — a client that never replies accumulates asks until seat-exit — but the
   requirement does not state a bound and we would rather ask upstream what they intend
   than invent a limit that surprises a caller. **Open question for upstream.**
