#!/usr/bin/env bash
# Are sendMessageDraft calls metered more loosely than editMessageText?
#
# The audit asserted drafts reduce 429 pressure. Telegram documents limits only in terms of
# *messages* ("up to 30 messages per second") and says nothing about drafts, so that was an
# assumption. This measures it — but read the caveats, because the naive version of this
# experiment cannot be trusted:
#
#   PACED, NOT BURST. Firing N requests at once tests a token bucket's burst capacity, not a
#   per-second rate. Requests go out on a fixed interval (RATE_HZ) sustained for DURATION_S,
#   long enough to drain any burst allowance.
#
#   CHANGING PAYLOADS. Repeating one identical empty draft may be coalesced or treated as a
#   no-op, which would make the draft arm pass trivially. Every draft carries different,
#   non-empty text, like real streaming.
#
#   COUNTERBALANCED. Whichever arm runs first gets a clean bucket. If the two share a bucket,
#   a fixed order always flatters the first. Both orders are run, separated by a quiet window,
#   and the verdict only stands if both orders agree.
#
#   NON-429 FAILURES COUNTED. An arm that fails with 400s is not "passing".
#
# Still does NOT isolate: whether drafts and edits draw on the same bucket at all. A
# disagreement between orders is the tell — it is reported rather than averaged away.
#
# Requires CHAT_ID (your numeric Telegram user id). Drafts self-expire in 30s; the seeded
# comparison message is deleted at the end.
#
# Token is piped from the cluster secret into Bun's stdin: never a shell variable, never
# exported, never in argv. All output passes through a redaction filter.
set -euo pipefail
set +x # defeat inherited tracing regardless of how we were invoked

NS=${NS:-claude-telegram}
SECRET=${SECRET:-claude-telegram-env}
RATE_HZ=${RATE_HZ:-4} # requests per second per arm; above the ~1/sec per-chat message rate
DURATION_S=${DURATION_S:-15}
QUIET_S=${QUIET_S:-60} # cooldown between the two orders
: "${CHAT_ID:?set CHAT_ID to your numeric Telegram user id, e.g. CHAT_ID=12345678 $0}"

# shellcheck disable=SC2016 # the JS below is single-quoted on purpose: ${...} must reach Bun unexpanded
main() {
	kubectl get secret "$SECRET" -n "$NS" -o jsonpath='{.data.telegram-bot-token}' |
		base64 -d |
		CHAT_ID="$CHAT_ID" RATE_HZ="$RATE_HZ" DURATION_S="$DURATION_S" QUIET_S="$QUIET_S" bun -e '
const token = (await Bun.stdin.text()).trim();
const chatId = Number(process.env.CHAT_ID);
const rate = Number(process.env.RATE_HZ);
const dur = Number(process.env.DURATION_S);
const quiet = Number(process.env.QUIET_S);
if (!token) { console.error("empty telegram-bot-token"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, body) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: j.ok === true, retry: j.parameters?.retry_after ?? 0, desc: (j.description ?? "").slice(0, 60) };
  } catch (e) { return { status: 0, ok: false, retry: 0, desc: `transport: ${String(e).slice(0, 40)}` }; }
};

// Paced arm: one request every 1000/rate ms for dur seconds, sequential so the cadence is real.
const arm = async (label, mk) => {
  const gap = Math.round(1000 / rate);
  const n = rate * dur;
  const res = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    res.push(await mk(i));
    const spent = performance.now() - t;
    if (spent < gap) await sleep(gap - spent);
  }
  const ok = res.filter((r) => r.ok).length;
  const t429 = res.filter((r) => r.status === 429);
  const otherFail = res.filter((r) => !r.ok && r.status !== 429);
  const maxRetry = t429.reduce((m, r) => Math.max(m, r.retry), 0);
  console.log(`  ${label.padEnd(22)} ok=${String(ok).padEnd(4)} 429=${String(t429.length).padEnd(4)} otherFail=${String(otherFail.length).padEnd(4)}${maxRetry ? ` maxRetryAfter=${maxRetry}s` : ""}`);
  if (otherFail.length) console.log(`  ${" ".repeat(22)} first other failure: ${otherFail[0].status} ${otherFail[0].desc}`);
  // Respect any flood penalty before the next arm so it does not inherit ours.
  if (maxRetry) { console.log(`  ${" ".repeat(22)} waiting out retry_after=${maxRetry}s`); await sleep((maxRetry + 1) * 1000); }
  return { ok, t429: t429.length, otherFail: otherFail.length };
};

const draftArm = () => arm("sendMessageDraft", (i) =>
  call("sendMessageDraft", { chat_id: chatId, draft_id: 424242, text: `streaming chunk ${i} ${"x".repeat(i % 40)}` }));

let seededId = null;
const editArm = async () => {
  if (!seededId) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "rate-limit probe (deleted on completion)" }),
    });
    seededId = (await r.json().catch(() => ({})))?.result?.message_id;
    if (!seededId) { console.error("could not seed the comparison message"); process.exit(1); }
  }
  return arm("editMessageText", (i) =>
    call("editMessageText", { chat_id: chatId, message_id: seededId, text: `probe edit ${i} ${Date.now()}` }));
};

const reach = await call("sendMessageDraft", { chat_id: chatId, draft_id: 1, text: "reachability check" });
if (!reach.ok) { console.error(`chat unreachable: ${reach.status} ${reach.desc} — is CHAT_ID your own user id?`); process.exit(1); }
console.log(`chat ok. ${rate}/s for ${dur}s per arm, both orders, ${quiet}s quiet window between.\n`);

console.log("ORDER 1 — drafts first");
const o1d = await draftArm();
const o1e = await editArm();

console.log(`\nquiet window ${quiet}s...`);
await sleep(quiet * 1000);

console.log("\nORDER 2 — edits first");
const o2e = await editArm();
const o2d = await draftArm();

if (seededId) await call("deleteMessage", { chat_id: chatId, message_id: seededId });

// A verdict only counts if BOTH orders agree; disagreement means a shared bucket or
// order effects dominate, and the experiment cannot answer the question as run.
const looser = (d, e) => d.t429 === 0 && e.t429 > 0;
const bothThrottle = (d, e) => d.t429 > 0 && e.t429 > 0;
const neither = (d, e) => d.t429 === 0 && e.t429 === 0;
const anyBadData = [o1d, o1e, o2d, o2e].some((a) => a.otherFail > 0);

console.log("\n--- verdict ---");
if (anyBadData) console.log("CAUTION: an arm had non-429 failures; treat the counts below as unreliable.");
if (looser(o1d, o1e) && looser(o2d, o2e))
  console.log("Drafts are metered MORE LOOSELY than edits — consistent in BOTH orders. Assumption holds.");
else if (bothThrottle(o1d, o1e) && bothThrottle(o2d, o2e))
  console.log("Both throttle in both orders. Drafts are NOT a free pass; budget them like edits.");
else if (neither(o1d, o1e) && neither(o2d, o2e))
  console.log(`INCONCLUSIVE — nothing hit a limit at ${rate}/s. Re-run with RATE_HZ=${rate * 3}.`);
else
  console.log("INCONCLUSIVE — the two orders DISAGREE, so order effects or a shared bucket dominate. Do not draw a conclusion from this run.");
'
}

main 2>&1 | sed -E 's/(bot)?[0-9]{6,}:[A-Za-z0-9_-]{30,}/<REDACTED>/g'
