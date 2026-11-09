# CAMP v1 — Collaborative Agent Mediation Protocol

- Status: Draft (2026-11-08)
- Wire version: `"1"`
- Reference implementation: `@camp-protocol/kit` (this package)
- Conformance tests: `test/quick-vote.test.ts`, `test/boundary.test.ts`

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Scope

CAMP keeps a shared **room** consistent while several **participants** act on it at once and slow work, typically AI generation, finishes in between.
It runs over WebSocket (RFC 6455). Each text frame carries exactly one JSON object.

CAMP defines the envelope, ordering, replies, retries, reconnection and versioning.
The **vocabulary** (command types and payloads, event types, reject reasons, state shape) belongs to the application. Section 9 shows how to describe it.

## 2. Terms

| Term | Meaning |
|---|---|
| Room | One shared session. Identified by `sessionId` in `hello`. The application decides which rooms exist (§3.1) |
| Participant | A person (or agent) who may send commands. Gets a `participantId` from the server |
| Spectator | A connection without a participant seat. Receives everything, may not send commands |
| Host | One participant the server marks as host (the earliest connected participant by default). Apps MAY use it in their rules |
| Snapshot | The full, current state of the room as the app wants clients to see it. Always includes `seq` |
| `seq` | A per-room counter, incremented by one for every event |

## 3. Messages

Every message has `camp: "1"` and a `kind`.

| kind | Direction | Reply | Purpose |
|---|---|---|---|
| `hello` | client → server | `welcome` | Join a room. First message on every connection |
| `welcome` | server → client | — | Your participant ID (or `null` for spectators) and the snapshot |
| `command` | client → server | `result` | Ask to change the room |
| `result` | server → sender | — | Whether the command was applied, and why not |
| `event` | server → everyone in the room | — | Something changed. Carries `seq` and the full snapshot |
| `ephemeral` | both | — | Short-lived sharing (cursors, mic on). Not stored, latest wins |
| `signal` | client → server | — | A soft reaction ("hmm", hesitation). No reply, MAY be dropped |
| `protocol_error` | server → client | — | The message could not be handled. Says why |

### 3.1 hello

```json
{ "camp": "1", "kind": "hello", "sessionId": "kqd-rmzw-tbe", "participantId": "p_2", "resumeToken": "…", "lastSeq": 41 }
```

- `sessionId` (required): the room.
- `participantId` (optional): the ID from an earlier `welcome`.
- `resumeToken` (optional, 1–128 chars): the token from that same `welcome`. The server MUST restore the participant only when both match (§7, §12). A `participantId` alone is not enough, because participant IDs are visible to everyone in the snapshot.
- `lastSeq` (optional): the last `seq` the client applied. Informational in v1, since `welcome` always carries the full snapshot.

If the room does not exist, the server answers `protocol_error{ROOM_NOT_FOUND}` and closes with 4404.
Whether joining creates a room or only rooms the application created can be joined is the application's choice.
A common pattern is the meeting link: the host creates a room, the server returns a hard-to-guess ID (the reference implementation's `randomRoomId()` gives IDs like `kqd-rmzw-tbe`), and whoever opens the link joins.

The server MUST close the connection with 4408 if no valid `hello` arrives within its hello timeout (10 s in the reference implementation).
Messages sent before `hello` get `protocol_error{NOT_JOINED}`; a command also gets `result{ok:false, reason:"NOT_AUTHORIZED"}`.

### 3.2 welcome

```json
{ "camp": "1", "kind": "welcome", "participantId": "p_2", "resumeToken": "…", "snapshot": { "seq": 43, "…": "…" } }
```

`participantId: null` means the room is full and the connection is a spectator.
`resumeToken` is a secret for this participant only. The server sends it only on this connection and MUST NOT put it in the snapshot or in events. The client keeps it (for example in session storage) and sends it back in `hello` to come back as the same participant.
After `welcome`, the client MUST replace its state with `snapshot` and continue counting from `snapshot.seq`.

### 3.3 command

```json
{ "camp": "1", "kind": "command", "type": "VOTE", "commandId": "4f1c…", "sentAt": "2026-11-08T10:00:00.000Z",
  "expected": { "rev": "r_17" }, "payload": { "option": 1 } }
```

- `commandId` (required, 1–80 chars): unique per participant. Used to detect duplicates (§5.2).
- `expected` (optional): the version of the target the client was looking at (§6.2).
- `payload`: validated against the app's schema for `type`.

### 3.4 result

```json
{ "camp": "1", "kind": "result", "commandId": "4f1c…", "ok": false, "reason": "ALREADY_VOTED" }
```

`reason` is `null` when `ok` is `true`. Otherwise it is one of the app's reject reasons or a core reason:

| Core reason | When |
|---|---|
| `INVALID_PAYLOAD` | The type is known but the payload does not match its schema (or the handler failed) |
| `UNKNOWN_TYPE` | The server does not know this command type |
| `NOT_AUTHORIZED` | The sender has not joined, or is not allowed |
| `SPECTATOR` | Spectators may not send commands |
| `STALE_VERSION` | `expected.rev` no longer matches (§6.2) |

### 3.5 event

```json
{ "camp": "1", "kind": "event", "type": "VOTED", "seq": 44, "correlationId": null, "actorId": "p_2",
  "detail": { "by": "p_2" }, "snapshot": { "seq": 44, "…": "…" } }
```

- `seq`: exactly one more than the previous event in this room.
- `correlationId`: the `commandId` that caused this event, when the app sets it; otherwise `null`.
- `actorId`: the participant who caused it, or `null` for server-side work such as AI results.
- `detail`: a hint for animation and wording. The snapshot is the source of truth.
- `snapshot`: the full state **after** this event.

### 3.6 ephemeral

```json
{ "camp": "1", "kind": "ephemeral", "type": "CURSOR", "payload": { "x": 0.4, "y": 0.7 } }
```

The server relays ephemerals from participants to the other connections in the room. It MUST overwrite `senderId` with the sender's real participant ID. Ephemerals are never stored and never get a `seq`.

### 3.7 signal

```json
{ "camp": "1", "kind": "signal", "type": "HMM", "payload": {} }
```

Signals carry vague, frequent reactions that should influence the room without being commands.
They get no reply. The server MAY drop them; the reference room accepts 2 per participant per second.
If a signal changes the room, the server reports that with a normal `event`.

### 3.8 protocol_error

```json
{ "camp": "1", "kind": "protocol_error", "code": "MALFORMED", "detail": "not JSON", "supported": ["1"] }
```

| `code` | When | Then |
|---|---|---|
| `UNSUPPORTED_VERSION` | `camp` is missing or not supported | Close with 4400 if it was the `hello` or the client has not joined |
| `MALFORMED` | Not JSON, or a known `kind` with the wrong shape | Connection stays open |
| `UNKNOWN_TYPE` | Unknown `kind` | Connection stays open |
| `NOT_JOINED` | Anything but `hello` before joining | Connection stays open |
| `RATE_LIMITED` | Too many messages (120 per second per connection in the reference implementation) | Close with 4429 |
| `ROOM_NOT_FOUND` | The room in `hello` does not exist | Close with 4404 |

The server MUST NOT silently drop malformed messages; it tells the sender what was wrong.

## 4. Ordering

- The server MUST process the messages of one room one at a time, in arrival order.
- Every state change is announced by an `event` with the next `seq`, sent to every connection in the room in the same order.
- A client MUST ignore events whose `seq` is less than or equal to the last one it applied.
- Because every event carries the full snapshot, a client that missed events can recover from the next one it receives.

## 5. Commands

### 5.1 Flow

1. The client sends `command` and keeps it as pending.
2. The server validates the shape (§3.4 `INVALID_PAYLOAD` / `UNKNOWN_TYPE`), then the sender (`SPECTATOR` / `NOT_AUTHORIZED`), then runs the app's rule.
3. If the rule rejects, the state does not change and only the sender gets `result{ok:false, reason}`.
4. If the rule accepts, the state changes, the events go to everyone, and the sender gets `result{ok:true}`.

A rule MUST either reject without changing the state or apply all of its changes. There is no partial apply.

### 5.2 Duplicates

The server MUST remember the result for each `(participant, commandId)` pair and return the same result, without running the command again, if the pair comes back.
The reference implementation remembers the last 500 results per room.
This makes it safe for clients to resend a command whenever they are unsure it arrived.

### 5.3 Timeouts

A client MAY give up waiting for a result (8 s in the reference client) and report `TIMEOUT` locally. The server may still apply the command; the next event shows the truth.

## 6. Conflicts

### 6.1 Check the state, not the arrival time (default)

Rules check preconditions against the current state: "is the poll still open", "is there a free slot".
When two participants race for the last slot, the first command processed wins and the second is rejected with the app's reason. Both screens then show the same winner, because both get the same events.

### 6.2 Check the target's version

When a participant acts on something that may have changed while they were reading it (for example an AI just revised it), the client MAY send `expected.rev` with the version it saw.
The app SHOULD reject with `STALE_VERSION` when the target has moved on.
CAMP carries the field; the app decides what a version is.

## 7. Disconnects and recovery

1. The client reconnects with exponential backoff (400 ms doubling, capped at 5 s in the reference client).
2. It sends `hello` with its `participantId`, `resumeToken` (and `lastSeq`).
3. The server restores the same participant seat if it still exists **and the token matches**. Otherwise the connection joins as a new participant (or a spectator if the room is full). The host role is not given back if it moved to someone else meanwhile.
4. `welcome` carries the full snapshot. The client replaces its state.
5. The client resends every command still waiting for a result, with the **same** `commandId`. Duplicates are answered from §5.2, so nothing runs twice.

The client MUST NOT reconnect after close codes 4400 or 4404.

The server SHOULD send WebSocket pings (every 25 s in the reference implementation) and drop connections that do not answer.

## 8. Slow work and stale results

AI generation and other slow work run outside the room's queue. When the work finishes, its result is applied inside the queue like any other change.

A room has an **epoch**. Resetting the room (starting over) increments it.
The server MUST discard results of work that started in an earlier epoch. This prevents an answer to an old question from appearing in a new session.
In the reference implementation, `room.task(work, then)` records the epoch, and `room.reset(state)` increments it.
An error thrown by `work` or by the code that applies its result MUST NOT take the server down. The reference implementation catches it and logs it.

Apps SHOULD additionally use §6.2 for results that depend on a specific version of a target.

## 9. Vocabulary

An application describes its vocabulary once and shares it between server and client.
With the reference implementation:

```ts
const vocabulary = defineVocabulary({
  commands: { VOTE: z.object({ option: z.number().int() }) }, // type → payload schema
  events: ['VOTED'],                                           // event types
  rejectReasons: ['ALREADY_VOTED'],                            // app reasons; core reasons are added
  snapshot: z.object({ seq: z.number(), /* … */ }),            // state shape
  ephemerals: { CURSOR: z.object({ x: z.number(), y: z.number() }) },
  signals: { HMM: z.object({}) },
});
```

Implementations in other languages SHOULD accept the same information, for example as JSON Schema.

## 10. Versioning

- `camp` is the major version as a string. It changes only for breaking changes: changing the meaning of a field, or adding a required field.
- Optional fields MAY be added within a version. Receivers MUST ignore fields they do not know.
- A server that cannot speak the client's version answers `protocol_error{UNSUPPORTED_VERSION, supported}` and closes with 4400.

## 11. Close codes

| Code | Meaning | Client reconnects? |
|---|---|---|
| 4400 | Unsupported version | No |
| 4404 | Room not found | No |
| 4408 | No `hello` in time | Yes |
| 4429 | Rate limited | Yes, after backoff |
| 1011 | The server could not open the room | Yes |

## 12. Security

- The server MUST derive the actor from the connection, never from fields the client sends (`senderId` and similar are overwritten).
- Returning as an earlier participant MUST require the `resumeToken` given in that participant's `welcome` (§3.1, §3.2). Tokens SHOULD be random (the reference implementation uses 24 random bytes) and compared in constant time.
- Room IDs that work as invitations SHOULD be hard to guess, and servers SHOULD limit how fast rooms can be created and how many can exist at once (the reference `createCampServer` keeps at most `maxRooms`, 100 by default).
- Servers SHOULD cap the frame size (64 KiB in the reference implementation) and the message rate.
- CAMP does not define user authentication. Put it in front of the WebSocket upgrade, or decide in the room registry who may enter which room.

## 13. Conformance

An implementation conforms to CAMP v1 if it passes these behaviors, all covered by the reference tests:

1. Concurrent commands for the last slot produce one winner and the same final state on every client
2. Rejected commands change nothing and return the app's reason to the sender only
3. A resent `commandId` returns the first result without running again
4. A client that loses its connection reconnects, keeps its participant ID, and receives the current state
5. Results of slow work started before a reset are discarded
6. Connections beyond the participant limit become spectators and get `SPECTATOR` for commands
7. Signals beyond the per-person rate are dropped
8. Unknown command types get `UNKNOWN_TYPE`; an unsupported version is closed with 4400
9. When rooms are created by the application, joining an unknown room gets `ROOM_NOT_FOUND` and the client does not reconnect
10. A `hello` that names another participant's ID without that participant's `resumeToken` does not become that participant
