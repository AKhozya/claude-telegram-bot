/**
 * Poll-liveness heartbeat consumed by the deployment's livenessProbe.
 */

import { writeFileSync } from "fs";
import type { Api, Transformer } from "grammy";

/**
 * Touches `path` after every successful `getUpdates` round trip.
 *
 * A process-alive check passes while the poller is wedged: on 2026-08-07 a
 * multi-hour network outage left the runner's retry sleeping on an hours-long
 * exponential backoff, so the process sat "healthy" with updates queued
 * server-side long after the network recovered. Only `getUpdates` refreshes the
 * file because only it proves messages can still arrive — the send path can
 * succeed while the poller sleeps out its backoff.
 *
 * The probe reads mtime, so freshness survives a restart-in-place of the
 * kubelet; file content is debugging convenience only.
 */
export function installPollHeartbeat(api: Pick<Api, "config">, path: string): void {
  const heartbeat: Transformer = async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method === "getUpdates" && res.ok) {
      beat(path);
    }
    return res;
  };
  api.config.use(heartbeat);
}

/**
 * Also called once at startup: the probe cannot tell "no file yet" from
 * "poller dead", so the boot write plus the probe's initialDelaySeconds covers
 * the window between container start and the first successful poll.
 *
 * Fire-and-forget: a full /tmp or unwritable path must degrade to a missed
 * heartbeat (the probe restarts the pod), never to a crashed poller.
 */
export function beat(path: string): void {
  try {
    writeFileSync(path, `${Date.now()}\n`);
  } catch {
    // Swallowed by design — see above.
  }
}
