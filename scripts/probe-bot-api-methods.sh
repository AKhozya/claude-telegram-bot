#!/usr/bin/env bash
# Does the live Bot API server actually implement the methods our types declare?
#
# Types are generated from Telegram's published docs, so a method can typecheck against
# @grammyjs/types and still 404 on the server. This asks the server directly.
#
# Nothing is ever delivered: chat_id 0 is not a valid chat, so every probe fails on the
# target before any send occurs. Two controls run first — a method that certainly exists
# and one that certainly does not — so the verdicts are calibrated against THIS server
# rather than assumed. A response that is neither of the control shapes is reported as
# INCONCLUSIVE rather than guessed at.
#
# Secret handling: the token is piped straight from the cluster secret into Bun's stdin.
# It is never assigned to a shell variable, never exported, and never appears in argv —
# so shell tracing, the process table, and the environment cannot expose it. All output,
# stdout and stderr alike, is passed through a redaction filter as a backstop.
set -euo pipefail
set +x # defeat inherited tracing (set -x / BASH_ENV) regardless of how we were invoked

NS=${NS:-claude-telegram}
SECRET=${SECRET:-claude-telegram-env}

# shellcheck disable=SC2016 # the JS below is single-quoted on purpose: ${...} must reach Bun unexpanded
main() {
	kubectl get secret "$SECRET" -n "$NS" -o jsonpath='{.data.telegram-bot-token}' |
		base64 -d |
		bun -e '
const token = (await Bun.stdin.text()).trim();
if (!token) { console.error("empty telegram-bot-token — check the secret name/key"); process.exit(1); }

const call = async (method, body) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: j.ok === true, desc: (j.description ?? "").slice(0, 70) };
  } catch (e) {
    return { status: 0, ok: false, desc: `transport error: ${String(e).slice(0, 60)}` };
  }
};

// Controls define what each verdict looks like on this server.
const real = await call("getMe", {});
const fake = await call("thisMethodDoesNotExist", {});
const missing = (r) => r.status === fake.status && /not found/i.test(r.desc);

if (!real.ok) {
  console.error(`control failed: getMe returned ${real.status} ${real.desc} — token or network problem, verdicts unusable`);
  process.exit(1);
}
if (!/not found/i.test(fake.desc)) {
  console.error(`control failed: a bogus method returned ${fake.status} ${fake.desc}, not a "not found" — cannot calibrate`);
  process.exit(1);
}
console.log(`controls ok: real method -> ${real.status}; unknown method -> ${fake.status} "${fake.desc}"`);
console.log("-".repeat(94));

// chat_id 0 is invalid, so these fail on the target, never on delivery.
const PROBES = [
  ["sendMessageDraft", { chat_id: 0, draft_id: 1, text: "probe" }],
  ["sendRichMessageDraft", { chat_id: 0, draft_id: 1, rich_message: { blocks: [{ type: "thinking", text: "x" }] } }],
  ["sendRichMessage", { chat_id: 0, rich_message: { blocks: [{ type: "paragraph", text: "x" }] } }],
  ["editEphemeralMessageText", { chat_id: 0, receiver_user_id: 0, ephemeral_message_id: 1, text: "x" }],
];

let inconclusive = 0;
for (const [method, body] of PROBES) {
  const r = await call(method, body);
  let verdict;
  if (missing(r)) verdict = "NOT IMPLEMENTED";
  else if (r.status === 400) verdict = "implemented";
  else { verdict = "INCONCLUSIVE"; inconclusive++; }
  console.log(`${method.padEnd(26)} http=${String(r.status).padEnd(4)} ${verdict.padEnd(16)} ${r.desc}`);
}
if (inconclusive) console.log(`\n${inconclusive} INCONCLUSIVE — neither a 400 parameter error nor the unknown-method shape. Judge by hand.`);
'
}

# Redact anything token-shaped from BOTH streams: the URL form (bot<id>:<secret>) and
# the bare form that a stack trace or env dump could emit.
main 2>&1 | sed -E 's/(bot)?[0-9]{6,}:[A-Za-z0-9_-]{30,}/<REDACTED>/g'
