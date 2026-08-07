# Test coverage plan — 2026-07-29

## Measured baseline

`bun test --coverage`, commit `528cb8d`: **190 tests / 14 files, 62.03% funcs, 57.98% lines.**

| File                      | % lines | tests | Note                              |
| ------------------------- | ------- | ----- | --------------------------------- |
| `handlers/auth.ts`        | 100     | 4     |                                   |
| `handlers/download.ts`    | 100     | 1     |                                   |
| `handlers/reactions.ts`   | 100     | 3     |                                   |
| `sandbox.ts`              | 100     | 15    |                                   |
| `security.ts`             | 92.29   | 122   | 64% of the whole suite            |
| `config.ts`               | 88.71   | —     | covered transitively              |
| `handlers/trigger.ts`     | 86.30   | 5     |                                   |
| `session.ts`              | 67.83   | 10    | across 3 files                    |
| `handlers/streaming.ts`   | 58.42   | 8     |                                   |
| `formatting.ts`           | 29.74   | 7     | `formatToolStatus` untouched      |
| `handlers/document.ts`    | 13.04   | 11    | security helpers covered; I/O not |
| `handlers/media-group.ts` | 10.27   | 0     |                                   |
| `handlers/photo.ts`       | 9.09    | 0     |                                   |
| `handlers/commands.ts`    | 7.35    | 2     |                                   |
| `utils.ts`                | 6.60    | 0     |                                   |

Absent from the report entirely — never imported by any test, so 0%:
`index.ts`, `handlers/callback.ts` (200 lines), `handlers/text.ts` (118), `handlers/video.ts` (142), `handlers/media.ts`, `handlers/index.ts`.

## The number is not the target

security.ts sits at 92% because it is the security surface and every branch is an attack the parser must refuse. The handlers sit at 10% because most of their lines are Telegram API plumbing, where a test asserts only that a mock was called. Raising `handlers/photo.ts` to 90% would add tests that break on every refactor and catch nothing.

Rank by **bug class prevented**, not by percent. The list below does that; the resulting global number lands around 70%, and that is a side effect, not the goal.

## Assumptions

| #   | Assumption                                                                                          | Tier                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `coverageThreshold` in `bunfig.toml [test]` fails the run                                           | ✅ probed 2026-07-29 — `0.99` gave exit 1 with 0 test failures                                                                                  |
| 2   | A fake grammY `Context` can drive a handler without network                                         | ✅ `commands.test.ts` already does it (`Object.create(proto)` with prototype getters for `message`/`chat`/`from`)                               |
| 3   | SDK session functions are real, not stubs                                                           | ✅ probed — `listSessions({limit:3})` returned live sessions despite `_`-prefixed param names                                                   |
| 4   | `mock.module("./session")` leaks exactly like the SDK mock did                                      | 🟡 same mechanism, not re-probed. Use the copy-snapshot + `afterAll` re-mock from `session-reset.test.ts` and the guard test that comes with it |
| 5   | `handleText`'s retry loop is drivable by making `sendMessageStreaming` throw `"exited with code 1"` | ⚠ my call — needs a spike before writing the P1.4 tests                                                                                         |

**Validate before build:** items 4 and 5. Both are one short spike against the real loop, same shape as `session-reset.test.ts`.

## Priority 1 — untested logic that gates every message

1. **`utils.ts: checkInterrupt`** — 0 tests today, runs on every text message. Table test: no prefix passes through; `!foo` strips and interrupts; `!stop` and `!/stop` return `""` (pure stop alias, no prompt forwarded); `!` alone returns `""`. Pure apart from the lazy `./session` import — see assumption 4.
2. **`handlers/callback.ts`: the `requestId` charset guard** — `/^[A-Za-z0-9_-]+$/` is the only thing stopping `../` in a `/tmp` path that is then read _and_ `unlinkSync`'d. A security control with zero tests. Extract nothing; drive `handleCallback` with a fake ctx and assert a traversal id is rejected before any file touch.
3. **`handlers/media-group.ts`: `addToGroup`** — real logic, no tests: rate limit charged once per album not per item; first caption wins regardless of arrival order; the debounce timer resets per item and fires once. Use fake timers, no Telegram.
4. **`handlers/text.ts`: the crash-retry loop** — `MAX_RETRIES = 1`, retry only on `"exited with code"`, and the interrupt-vs-explicit-stop branch that decides whether "🛑 Query stopped." is shown. Four distinct outcomes, none covered. Gated on assumption 5.

## Priority 2 — branch-heavy, has produced real bugs

5. **`handlers/streaming.ts`: `createStatusCallback`** — the rich→HTML→plain ladder, the `lastContent` skip-if-unchanged cache, and the segment_end chunking path. The "short response skips the text event" bug (#12) lived here. Assert the ladder degrades in order when each send throws, and that `lastContent` caches raw markdown (a regression here silently re-sends every edit).
6. **`formatting.ts`: `formatToolStatus`** — 140 uncovered lines, pure function, no mocks needed. Cheap. Catches MCP name-mangling regressions (`mcp__exa__exa_search` → `exa search`) and the emoji-map insertion-order tie-break.

## Priority 3 — worth it only when touched

7. `handlers/commands.ts: handleStatus` / `handleResume` — string and button builders over session state. Test if either grows a branch.
8. `handlers/photo.ts`, `video.ts`, `document.ts` I/O paths — plumbing. document.ts's security helpers (`isUnsafeMemberName`, `stripLinks`, `listArchiveMembers`, `sortPdfPagePaths`, `pdfHasUsableText`) are already exported and covered; that is the part that matters.

## Deliberately not tested

- `index.ts` — wiring only. A test would assert `bot.on` was called, which the next refactor breaks for no signal.
- Telegram API round-trips. `@grammyjs/auto-retry` owns retry; not ours to verify.

## Ratchet

Once P1 lands, add to `bunfig.toml`:

```toml
[test]
coverageThreshold = 0.66
```

Set it just under the measured value at the time and raise it with each batch. Probed: it fails the run on a drop, so it works as a CI gate. Do **not** set a per-file threshold — it would force plumbing tests on the handlers this plan deliberately skips.
