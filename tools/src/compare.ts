/**
 * Fleet comparison: expected kills of attacker units against target-profile
 * archetypes. The cross product — a set of attacker units against a set of
 * targets — yielding a matrix of expected models killed per (unit, target).
 *
 * Target profiles reference real dataset units (`faction_id` + `unit_id`), so
 * each cell resolves the live unit and feeds it straight to {@link crunch}; the
 * target's defensive abilities (FNP, ability invulns, save/toughness mods) are
 * resolved via {@link Dataset.defensiveBuffsFor} and stacked onto the crunch.
 * Rapid Fire / Melta come for free: each cell sets `withinHalfRange` from
 * `distance <= range / 2`.
 *
 * Python mirror: `python/src/wh40kdc/compare.py`. The per-cell `expectedKills`
 * is pinned against Python by the `compare` conformance area.
 *
 * @packageDocumentation
 */
import { crunch, type EngineContext } from "./cruncher/index.js";
import type { Dataset } from "./data/dataset.js";
import { isMeleeProfile } from "./data/weapon-profile.js";
import type { UnitView } from "./data/entities.js";
import type { TargetProfile, Unit, Weapon } from "./generated.js";

export type ComparePhase = "shooting" | "fight";
export type CompareMetric = "best-weapon" | "unit-total";

/** Which weapon type fires in a phase: shooting → ranged, fight → melee. */
export function weaponTypeForComparePhase(phase: ComparePhase): "ranged" | "melee" {
  return phase === "fight" ? "melee" : "ranged";
}

/** One attacker weapon profile evaluated against one target. */
export interface WeaponCell {
  weaponId: string;
  weaponName: string;
  profileIndex: number;
  profileName: string;
  range: number | null;
  reaches: boolean;
  withinHalfRange: boolean;
  expectedKills: number;
}

/** One (attacker unit, target profile) pair across all the unit's weapons. */
export interface MatrixCell {
  targetProfileId: string;
  targetProfileName: string;
  best: WeaponCell | null;
  unitTotal: number;
  weapons: WeaponCell[];
}

export interface MatrixRow {
  unitId: string;
  unitName: string;
  cells: MatrixCell[];
  /** Peak cell value across targets — the row's sort key. */
  peak: number;
}

/** A target profile resolved to its live dataset unit. */
export interface ResolvedTarget {
  profileId: string;
  profileName: string;
  unitRaw: Unit;
  modelCount: number;
}

export function cellValue(cell: MatrixCell, metric: CompareMetric): number {
  if (metric === "unit-total") return cell.unitTotal;
  return cell.best?.expectedKills ?? 0;
}

/**
 * Resolve a target profile to its referenced unit, faction-scoped (shared ids
 * like Rhino/Forgefiend appear under several factions). Returns null if the
 * referenced unit is absent.
 */
export function resolveTarget(ds: Dataset, profile: TargetProfile): ResolvedTarget | null {
  const unit = ds.units.getInFaction(profile.unit_id, profile.faction_id);
  if (!unit) return null;
  const override = profile.model_count_override ?? null;
  const modelCount = override ?? unit.raw.model_count?.min ?? 1;
  return { profileId: profile.id, profileName: profile.name, unitRaw: unit.raw, modelCount };
}

/**
 * Expected models killed for one (weapon profile, target) at a distance. The
 * single unit of computation the matrix and the conformance corpus share.
 */
export function expectedKills(
  ds: Dataset,
  weaponRaw: Weapon,
  profileIndex: number,
  target: ResolvedTarget,
  phase: ComparePhase,
  modelsFiring: number,
  withinHalfRange: boolean,
): number {
  const ctx: EngineContext = { phase, withinHalfRange };
  const buffs = ds.defensiveBuffsFor(
    { unitId: target.unitRaw.id, factionId: target.unitRaw.faction_id },
    ctx,
  );
  const out = crunch(
    {
      attacker: { weapon: weaponRaw, profileIndex },
      target: { unit: target.unitRaw, profileIndex: 0, modelCount: target.modelCount },
      modelsFiring,
      buffs,
      context: ctx,
    },
    ds,
  );
  const stage = out.stages.find((s) => s.name === "models-killed");
  return stage ? stage.expected : 0;
}

/**
 * Expected post-FNP damage (wounds dealt) for one weapon profile against a
 * target. The summable counterpart to {@link expectedKills}: damage adds
 * linearly across weapons, so a unit's total output is built by summing this
 * over its loadout and converting to kills once — never by summing per-weapon
 * kills (each weapon's models-killed caps independently, which over-counts).
 */
export function expectedDamage(
  ds: Dataset,
  weaponRaw: Weapon,
  profileIndex: number,
  target: ResolvedTarget,
  phase: ComparePhase,
  modelsFiring: number,
  withinHalfRange: boolean,
): number {
  const ctx: EngineContext = { phase, withinHalfRange };
  const buffs = ds.defensiveBuffsFor(
    { unitId: target.unitRaw.id, factionId: target.unitRaw.faction_id },
    ctx,
  );
  const out = crunch(
    {
      attacker: { weapon: weaponRaw, profileIndex },
      target: { unit: target.unitRaw, profileIndex: 0, modelCount: target.modelCount },
      modelsFiring,
      buffs,
      context: ctx,
    },
    ds,
  );
  const stage = out.stages.find((s) => s.name === "after-fnp");
  return stage ? stage.expected : 0;
}

/**
 * Evaluate every phase-appropriate weapon profile of one attacker unit against
 * one target, returning per-weapon results plus the best.
 */
export function unitVsTarget(
  ds: Dataset,
  attackerUnit: UnitView,
  target: ResolvedTarget,
  distance: number,
  phase: ComparePhase,
  modelsFiring = 1,
): MatrixCell {
  const wantMelee = weaponTypeForComparePhase(phase) === "melee";
  const weapons: WeaponCell[] = [];
  for (const weapon of attackerUnit.weapons) {
    const wraw = weapon.raw;
    wraw.profiles.forEach((wprofile, idx) => {
      // Per-profile phase bucketing: a dual-profile weapon (e.g. The Wailing
      // Doom) contributes its melee profiles to the fight phase and its ranged
      // profiles to shooting. Single-type weapons are unaffected.
      if (isMeleeProfile(wprofile) !== wantMelee) return;
      const rng = wprofile.range;
      const isRanged = typeof rng === "number";
      const reaches = !isRanged || (rng as number) >= distance;
      const withinHalf = isRanged && distance <= (rng as number) / 2;
      const kills = reaches
        ? expectedKills(ds, wraw, idx, target, phase, modelsFiring, withinHalf)
        : 0;
      weapons.push({
        weaponId: wraw.id,
        weaponName: weapon.name,
        profileIndex: idx,
        profileName: wprofile.name ?? weapon.name,
        range: isRanged ? (rng as number) : null,
        reaches,
        withinHalfRange: withinHalf,
        expectedKills: kills,
      });
    });
  }
  const reaching = weapons.filter((w) => w.reaches);
  const best = reaching.reduce<WeaponCell | null>(
    (acc, w) => (acc === null || w.expectedKills > acc.expectedKills ? w : acc),
    null,
  );
  const unitTotal = reaching.reduce((sum, w) => sum + w.expectedKills, 0);
  return { targetProfileId: target.profileId, targetProfileName: target.profileName, best, unitTotal, weapons };
}

/** Result of evaluating one (attacker weapon profile, target profile) cell. */
export interface CompareCell {
  expectedKills: number;
  reaches: boolean;
  withinHalfRange: boolean;
  modelCount: number;
}

/**
 * Evaluate one (attacker weapon profile, target profile) cell — the single-cell
 * entry point shared by the conformance runner and consumers. Throws on unknown
 * profile/weapon ids so the runner can map them to the closed error enum.
 */
export function compareCell(
  ds: Dataset,
  opts: {
    factionId: string;
    unitId: string;
    weaponId: string;
    profileIndex: number;
    targetProfileId: string;
    distance: number;
    phase: ComparePhase;
    modelsFiring?: number;
  },
): CompareCell {
  const profile = ds.targetProfiles.get(opts.targetProfileId);
  if (!profile) throw new Error(`unknown target profile: ${opts.targetProfileId}`);
  const target = resolveTarget(ds, profile);
  if (!target) {
    throw new Error(
      `target profile ${opts.targetProfileId} references missing unit ${profile.unit_id}`,
    );
  }
  const weapon = ds.weapons.getAny(opts.weaponId);
  if (!weapon) throw new Error(`unknown weapon: ${opts.weaponId}`);
  const wraw = weapon.raw;
  const rng = wraw.profiles[opts.profileIndex]?.range;
  const isRanged = typeof rng === "number";
  const reaches = !isRanged || (rng as number) >= opts.distance;
  const withinHalfRange = isRanged && opts.distance <= (rng as number) / 2;
  const kills = reaches
    ? expectedKills(ds, wraw, opts.profileIndex, target, opts.phase, opts.modelsFiring ?? 1, withinHalfRange)
    : 0;
  return { expectedKills: kills, reaches, withinHalfRange, modelCount: target.modelCount };
}

/** The cross product: one row per attacker unit, one column per target. */
export function buildMatrix(
  ds: Dataset,
  attackerUnits: UnitView[],
  targets: ResolvedTarget[],
  distance: number,
  phase: ComparePhase,
  metric: CompareMetric,
  modelsFiring = 1,
): MatrixRow[] {
  const rows = attackerUnits.map((unit) => {
    const cells = targets.map((t) => unitVsTarget(ds, unit, t, distance, phase, modelsFiring));
    const peak = cells.reduce((m, c) => Math.max(m, cellValue(c, metric)), 0);
    return { unitId: unit.id, unitName: unit.name, cells, peak };
  });
  return rows.sort((a, b) => b.peak - a.peak);
}

// ---------------------------------------------------------------------------
// Loadout ranking — "what's the best shooting loadout for this unit/slot?"
// ---------------------------------------------------------------------------

/** One weapon in a loadout: `count` copies of `weaponId` profile `profileIndex`. */
export interface LoadoutLine {
  weaponId: string;
  profileIndex?: number;
  count: number;
}

/** A named weapon configuration to evaluate. `points` enables per-point ranking
 * and lets you compare unit *choices* (one Defiler vs two Forgefiends) on equal
 * footing — a config can span multiple bodies (just list all their weapons). */
export interface LoadoutConfig {
  label: string;
  points?: number | null;
  lines: LoadoutLine[];
}

export interface LoadoutTargetResult {
  targetProfileId: string;
  targetProfileName: string;
  /** Total post-FNP wounds the whole config deals to this target. */
  damage: number;
  /** Models killed = min(modelCount, damage / W) — capped once, after summing. */
  kills: number;
}

export interface LoadoutRanking {
  config: LoadoutConfig;
  results: LoadoutTargetResult[];
  /** The metric the configs were ranked by (damage against the rank target, or
   * summed across all targets when no rank target is given). */
  score: number;
  /** `score` per 100 points, or null when the config carries no points. */
  scorePer100Points: number | null;
}

/**
 * Total a single loadout against one target, summing post-FNP damage across all
 * weapon lines (each fired by `count` models) and converting to kills *once*.
 * A line whose weapon can't reach `distance` contributes nothing.
 */
export function loadoutOutput(
  ds: Dataset,
  config: LoadoutConfig,
  target: ResolvedTarget,
  distance: number,
  phase: ComparePhase,
): LoadoutTargetResult {
  let damage = 0;
  for (const line of config.lines) {
    const weapon = ds.weapons.getAny(line.weaponId);
    if (!weapon) continue;
    const profileIndex = line.profileIndex ?? 0;
    const rng = weapon.raw.profiles[profileIndex]?.range;
    const isRanged = typeof rng === "number";
    if (isRanged && (rng as number) < distance) continue; // out of range
    const withinHalf = isRanged && distance <= (rng as number) / 2;
    damage += expectedDamage(ds, weapon.raw, profileIndex, target, phase, line.count, withinHalf);
  }
  const w = target.unitRaw.profiles[0]?.W ?? 1;
  const kills = w > 0 ? Math.min(target.modelCount, damage / w) : 0;
  return {
    targetProfileId: target.profileId,
    targetProfileName: target.profileName,
    damage,
    kills,
  };
}

/**
 * Rank loadout configs against a set of targets. Each config is scored by its
 * damage against `rankTargetId` (or summed across all targets when omitted);
 * results are sorted high-to-low, with `scorePer100Points` for points-aware
 * comparison across unit choices.
 */
export function rankLoadouts(
  ds: Dataset,
  configs: LoadoutConfig[],
  targets: ResolvedTarget[],
  distance: number,
  phase: ComparePhase,
  rankTargetId?: string,
): LoadoutRanking[] {
  const ranked = configs.map((config) => {
    const results = targets.map((t) => loadoutOutput(ds, config, t, distance, phase));
    const score = rankTargetId
      ? (results.find((r) => r.targetProfileId === rankTargetId)?.damage ?? 0)
      : results.reduce((sum, r) => sum + r.damage, 0);
    const scorePer100Points =
      config.points && config.points > 0 ? (score / config.points) * 100 : null;
    return { config, results, score, scorePer100Points };
  });
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Evaluate one loadout against one target by ids — the single-call entry point
 * for the conformance runner. Throws on unknown profile so the runner maps it
 * to the closed error enum.
 */
export function loadoutCell(
  ds: Dataset,
  opts: {
    lines: LoadoutLine[];
    targetProfileId: string;
    distance: number;
    phase: ComparePhase;
  },
): { damage: number; kills: number } {
  const profile = ds.targetProfiles.get(opts.targetProfileId);
  if (!profile) throw new Error(`unknown target profile: ${opts.targetProfileId}`);
  const target = resolveTarget(ds, profile);
  if (!target) throw new Error(`target profile ${opts.targetProfileId} references a missing unit`);
  const res = loadoutOutput(ds, { label: "", lines: opts.lines }, target, opts.distance, opts.phase);
  return { damage: res.damage, kills: res.kills };
}

/** Result of deriving a unit's shooting-loadout space from its wargear. */
export interface EnumeratedLoadouts {
  configs: LoadoutConfig[];
  diagnostics: string[];
  /** Always false: the dataset doesn't record per-model weapon counts, so every
   * line defaults to count=1. Configs are reliable for *relative* slot ranking;
   * absolute totals need counts supplied by hand. */
  countsKnown: boolean;
}

function resolveWeaponId(ref: string, weaponIds: Set<string>): string | null {
  if (weaponIds.has(ref)) return ref;
  if (ref.endsWith("s") && weaponIds.has(ref.slice(0, -1))) return ref.slice(0, -1);
  return null;
}

/**
 * Derive the shooting-loadout choice space for a unit from its wargear options:
 * each mutually-exclusive ranged-weapon swap (grouped by option id) is an axis,
 * and the cross product yields candidate configs (count=1 per weapon). Mirror
 * of the Python `enumerate_loadouts`. Heuristic, not spec-pinned — it reflects
 * the (imperfect) wargear data and conservatively drops refs it can't resolve.
 */
export function enumerateLoadouts(
  ds: Dataset,
  factionId: string,
  unitId: string,
): EnumeratedLoadouts {
  const unit = ds.units.getInFaction(unitId, factionId);
  if (!unit) throw new Error(`unit ${unitId} not found in faction ${factionId}`);
  const weaponIds = new Set(ds.weapons.all.map((w) => w.raw.id));
  const isRanged = (wid: string): boolean =>
    (ds.weapons.getInFaction(wid, factionId) ?? ds.weapons.getAny(wid))?.raw.type === "ranged";
  const baseRanged = [
    ...new Set(unit.weapons.filter((w) => w.raw.type === "ranged").map((w) => w.raw.id)),
  ].sort();
  const diagnostics: string[] = [];

  // Group choices by option id so duplicate rows of one physical slot union
  // into a single exclusive axis (rather than letting two of its options stack).
  const choicesByOption = new Map<string, string[][]>();
  for (const opt of ds.wargearOptionsOf(unit.raw)) {
    const oid = opt.id ?? JSON.stringify(opt);
    const rawChoices: string[][] = [];
    const o = opt as { replaces?: string[]; replacement?: string[]; replacement_choice?: string[][] };
    if (o.replaces) rawChoices.push(o.replaces);
    if (o.replacement) rawChoices.push(o.replacement);
    for (const ch of o.replacement_choice ?? []) rawChoices.push(ch);
    const bucket = choicesByOption.get(oid) ?? [];
    for (const ch of rawChoices) {
      const rids: string[] = [];
      for (const ref of ch) {
        const wid = resolveWeaponId(ref, weaponIds);
        if (wid === null) diagnostics.push(`option ${oid}: unresolved ref ${JSON.stringify(ref)}`);
        else if (isRanged(wid)) rids.push(wid);
      }
      if (rids.length) {
        const key = [...rids].sort().join("|");
        if (!bucket.some((b) => [...b].sort().join("|") === key)) bucket.push(rids);
      }
    }
    choicesByOption.set(oid, bucket);
  }

  const axes = [...choicesByOption.values()].filter((c) => c.length > 1);
  const swapMembers = new Set(axes.flat(2));
  const fixed = baseRanged.filter((w) => !swapMembers.has(w));

  let combos: string[][] = [fixed];
  for (const axis of axes) {
    combos = combos.flatMap((combo) => axis.map((choice) => [...combo, ...choice]));
  }

  const byLabel = new Map<string, LoadoutConfig>();
  const points = unit.raw.points?.[0]?.cost ?? null;
  for (const combo of combos) {
    const weapons = [...new Set(combo)].sort();
    if (!weapons.length) continue;
    const label = weapons
      .map((w) => (ds.weapons.getInFaction(w, factionId) ?? ds.weapons.getAny(w))?.name ?? w)
      .join(" + ");
    if (!byLabel.has(label)) {
      byLabel.set(label, {
        label,
        points,
        lines: weapons.map((w) => ({ weaponId: w, count: 1 })),
      });
    }
  }
  return { configs: [...byLabel.values()], diagnostics: [...new Set(diagnostics)].sort(), countsKnown: false };
}

/** Render a matrix as a Discord-paste markdown table. */
export function matrixToMarkdown(
  rows: MatrixRow[],
  targets: ResolvedTarget[],
  metric: CompareMetric,
): string {
  const headers = ["Unit", ...targets.map((t) => t.profileName)];
  const lines = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const row of rows) {
    const cells = row.cells.map((c) => {
      const v = cellValue(c, metric);
      const text = v ? v.toFixed(2) : "—";
      return v >= 1 ? `**${text}**` : text;
    });
    lines.push(`| ${[row.unitName, ...cells].join(" | ")} |`);
  }
  return lines.join("\n");
}
