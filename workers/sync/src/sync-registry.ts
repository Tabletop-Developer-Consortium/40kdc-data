/**
 * Global live-session registry — the hard ceiling on DocRoom spend, cloned
 * from shadowboxing's SessionRegistry cap mechanism (no keys/admin: identity
 * lives at keys.alpacasoft.dev).
 *
 * One singleton instance (`getByName("global")`) counts active rooms.
 * Creation past MAX_DOC_SESSIONS is refused cleanly; registrations carry a
 * timestamp and a sweep drops entries older than the room TTL so a crashed
 * room can't leak its slot forever. Capacity refusals post a deduped Discord
 * alert when the webhook secret is configured.
 */
import { DurableObject } from "cloudflare:workers";
import { sendDiscordAlert, type AlertsEnv } from "./alerts";

export interface SyncRegistryEnv extends AlertsEnv {
  MAX_DOC_SESSIONS?: string;
  DOC_SESSION_TTL_MINUTES?: string;
}

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_TTL_MINUTES = 120;
const SWEEP_SLACK_MS = 30 * 60_000;
/** Capacity alerts dedupe to one per this window. */
const CAP_ALERT_DEDUPE_MS = 15 * 60_000;

export class SyncRegistry extends DurableObject<SyncRegistryEnv> {
  /** True while a capacity alert POST is pending; see maybeCapacityAlert. */
  private alertInFlight = false;

  constructor(ctx: DurableObjectState, env: SyncRegistryEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS active (
          code TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
      `);
    });
  }

  private maxSessions(): number {
    return Number(this.env.MAX_DOC_SESSIONS ?? DEFAULT_MAX_SESSIONS);
  }

  private sweepHorizonMs(): number {
    return Number(this.env.DOC_SESSION_TTL_MINUTES ?? DEFAULT_TTL_MINUTES) * 60_000 + SWEEP_SLACK_MS;
  }

  /** Try to register a new room. False = at capacity (creation must fail). */
  async tryAcquire(code: string): Promise<boolean> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM active WHERE created_at < ?", now - this.sweepHorizonMs());
    const count = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM active")
      .toArray()[0].n;
    if (count >= this.maxSessions()) {
      this.maybeCapacityAlert(count);
      return false;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO active (code, created_at) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET created_at = excluded.created_at",
      code,
      now,
    );
    return true;
  }

  /** Release a room's slot (idle eviction or explicit end). */
  async release(code: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM active WHERE code = ?", code);
  }

  /** Is this room currently registered? (e.g. "is this doc live right now") */
  async has(code: string): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM active WHERE code = ?", code)
        .toArray()[0].n > 0
    );
  }

  /** Re-stamp an active room's registration so the sweep can't reap a room
   *  that is still alive past the TTL horizon. Deliberately NOT an acquire:
   *  no capacity check, and a missing row stays missing. */
  async refresh(code: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE active SET created_at = ? WHERE code = ?",
      Date.now(),
      code,
    );
  }

  /** Current active-room count (ops/tests). */
  async activeCount(): Promise<number> {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM active")
      .toArray()[0].n;
  }

  /** "Demand exceeds supply" signal, deduped to ≤1 per window.
   *
   *  The dedupe marker is persisted only once Discord ACCEPTS the alert: a
   *  marker written up front would let one failed POST blackhole the next
   *  CAP_ALERT_DEDUPE_MS of alerts, which is the failure mode a capacity alarm
   *  can least afford. `alertInFlight` covers the resulting gap — the marker
   *  is not written while the POST is still pending, and a burst of refusals
   *  would otherwise fan out into one POST each. The DO is a singleton, so an
   *  in-memory flag is sufficient. */
  private maybeCapacityAlert(activeNow: number): void {
    if (this.alertInFlight) return;
    const row = this.ctx.storage.sql
      .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'last_cap_alert'")
      .toArray()[0];
    const now = Date.now();
    if (row && now - Number(row.v) < CAP_ALERT_DEDUPE_MS) return;
    this.alertInFlight = true;
    void sendDiscordAlert(this.env, [
      "**40kdc sync sessions — at capacity**",
      `A session creation was just refused: ${activeNow}/${this.maxSessions()} rooms in use.`,
      "If this keeps happening, raising MAX_DOC_SESSIONS is the lever (costs scale with it).",
    ])
      .then((delivered) => {
        if (!delivered) return;
        this.ctx.storage.sql.exec(
          "INSERT INTO meta (k, v) VALUES ('last_cap_alert', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
          String(now),
        );
      })
      .finally(() => {
        this.alertInFlight = false;
      });
  }
}
