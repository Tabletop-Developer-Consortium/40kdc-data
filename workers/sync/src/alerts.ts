/**
 * Discord webhook alerts (optional — silently a no-op without the secret).
 * Ported from shadowboxing's session-worker alerts: fire-and-forget, an
 * alerting failure must never fail the request that triggered it.
 *
 * "Best effort" is not "invisible": the POST's status IS checked and a bad
 * webhook is logged, because a revoked webhook (401/404) or a malformed body
 * (400) is otherwise indistinguishable from a delivered alert. The return
 * value lets a caller keep its dedupe state honest.
 */

export interface AlertsEnv {
  /** Discord channel webhook. Operator-set (`wrangler secret put`); alerts
   *  no-op when it is absent, which is the state in local dev and in forks. */
  DISCORD_WEBHOOK_URL?: string;
}

/** Outbound alerts must never wedge the caller behind a hung Discord. */
const ALERT_TIMEOUT_MS = 5_000;

/** @returns true only when Discord accepted the alert. */
export async function sendDiscordAlert(env: AlertsEnv, lines: string[]): Promise<boolean> {
  if (!env.DISCORD_WEBHOOK_URL) return false;
  try {
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.join("\n") }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Never log the URL itself — it is the credential.
      console.warn(`Discord alert rejected: HTTP ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    // Alerting is best-effort by design; surface it without throwing.
    console.warn("Discord alert failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
