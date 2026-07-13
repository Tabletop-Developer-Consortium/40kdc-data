/**
 * The expected-value damage engine.
 *
 * Closed-form math over schema profiles + a flat {@link Buff} stack. No
 * sampling, no I/O. Auto-injects every weapon-keyword on the attacker's
 * profile as a buff (so callers don't have to enumerate intrinsics), then
 * resolves the stack via {@link resolveBuffs}, then walks
 * attacks → hits → wounds → unsaved → damage → after-fnp → models-killed.
 *
 * The dataset is required (and defaults to the embedded one) — without it
 * the engine can't look up weapon-keyword effects.
 */
import type { Phase, Unit, Weapon } from "../generated.js";
import {
  type Buff,
  type EngineContext,
  resolveBuffs,
  type ResolvedModifiers,
  type WeaponKeywordRef,
} from "./buffs.js";
import { Dataset } from "../data/dataset.js";
import { isMeleeProfile } from "../data/weapon-profile.js";

export type AttackProfileRef = { weapon: Weapon; profileIndex: number };
export type TargetProfileRef = {
  unit: Unit;
  profileIndex: number;
  /** Override target model count (otherwise read from `unit.model_count.min`). */
  modelCount?: number;
};

export type Stage = {
  name: "attacks" | "hits" | "wounds" | "unsaved" | "damage" | "after-fnp" | "models-killed";
  expected: number;
  detail: string;
};

export type EngineInput = {
  attacker: AttackProfileRef;
  target: TargetProfileRef;
  modelsFiring: number;
  /** User / ability / manual buffs. Weapon-keyword buffs are auto-injected. */
  buffs: Buff[];
  context: EngineContext;
};

export type EngineOutput = { stages: Stage[]; resolved: ResolvedModifiers };

/**
 * Compute the expected per-stage projection for one (attacker, target, buffs)
 * triple. The dataset defaults to the embedded one — pass an alternate when
 * crunching against a different bundle (e.g. tests).
 */
export function crunch(input: EngineInput, dataset?: Dataset): EngineOutput {
  const ds = dataset ?? lazyEmbeddedDataset();
  const weaponProfile = input.attacker.weapon.profiles[input.attacker.profileIndex];
  if (!weaponProfile) {
    throw new RangeError(
      `crunch: attacker.profileIndex=${input.attacker.profileIndex} is out of range for weapon ${input.attacker.weapon.id}`,
    );
  }
  const unitProfile = input.target.unit.profiles[input.target.profileIndex];
  if (!unitProfile) {
    throw new RangeError(
      `crunch: target.profileIndex=${input.target.profileIndex} is out of range for unit ${input.target.unit.id}`,
    );
  }

  const targetKeywords = unitKeywordsLower(input.target.unit);
  const ctx: EngineContext = {
    ...input.context,
    targetKeywords: input.context.targetKeywords ?? targetKeywords,
  };

  // Auto-inject weapon-keyword buffs from the attacker profile, then append
  // the caller-supplied stack. resolveBuffs deduplicates and ranks them.
  const profileBuffs = profileBuffsFor(input.attacker, ds, ctx);
  const resolved = resolveBuffs([...profileBuffs, ...input.buffs], ctx);

  const stages: Stage[] = [];

  // 1. Attacks
  const isMelee = isMeleeProfile(weaponProfile);
  const baseA = evalStatValue(weaponProfile.stats.A);
  const attacksPerModel = baseA + resolved.attacksMod.value;
  const rapidFire = findKeyword(resolved, "rapid-fire");
  const halfRange = ctx.withinHalfRange === true;
  const rapidFireExtraPerModel = rapidFire && halfRange ? evalStatValue(rapidFire.parameters?.value) : 0;
  const blast = findKeyword(resolved, "blast");
  const targetModelCount = input.target.modelCount ?? input.target.unit.model_count?.min ?? 1;
  const blastExtraPerModel = blast ? Math.floor(targetModelCount / 5) : 0;
  const attacks = input.modelsFiring * (attacksPerModel + rapidFireExtraPerModel + blastExtraPerModel);
  stages.push({
    name: "attacks",
    expected: attacks,
    detail: attacksDetail(input.modelsFiring, attacksPerModel, rapidFireExtraPerModel, blastExtraPerModel),
  });

  // 2. Hits
  // Cover (11e): the benefit of cover is -1 to the attacker's hit roll, not a
  // save bonus. Ranged-only, negated by ignores-cover, and moot for auto-hitting
  // Torrent weapons (no hit roll).
  const ignoresCover = !!findKeyword(resolved, "ignores-cover");
  const covered =
    resolved.cover.active && !ignoresCover && !isMelee;
  const coverHitPenalty = covered ? -1 : 0;
  const hitStat = isMelee ? weaponProfile.stats.WS : weaponProfile.stats.BS;
  const torrent = !!findKeyword(resolved, "torrent");
  let hits: number;
  let critHits: number;
  let hitsDetail: string;
  if (torrent) {
    hits = attacks;
    critHits = 0;
    hitsDetail = `Torrent: auto-hits (${attacks.toFixed(4)})`;
  } else {
    if (typeof hitStat !== "number") {
      throw new Error(
        `crunch: weapon ${input.attacker.weapon.id} profile ${input.attacker.profileIndex} missing ${isMelee ? "WS" : "BS"}`,
      );
    }
    const probs = checkProbabilities({
      unmodifiedNeeded: hitStat,
      modifier: resolved.hitMod.value + coverHitPenalty,
      reroll: resolved.rerolls.hit?.subset ?? "none",
      autoFailOnOne: true,
      autoPassOnSix: true,
      critThreshold: 6,
    });
    hits = attacks * probs.pass;
    critHits = attacks * probs.crit;
    hitsDetail = `${isMelee ? "WS" : "BS"}${hitStat}+ (mod ${signed(resolved.hitMod.value)}${covered ? ", cover -1" : ""}, reroll ${resolved.rerolls.hit?.subset ?? "none"}) → P(hit)=${probs.pass.toFixed(4)}, P(crit)=${probs.crit.toFixed(4)}`;
  }
  const sustained = findKeyword(resolved, "sustained-hits");
  if (sustained) {
    hits += critHits * evalStatValue(sustained.parameters?.value);
    hitsDetail += `; +Sustained Hits ${sustained.parameters?.value ?? 1} on ${critHits.toFixed(4)} crits`;
  }
  stages.push({ name: "hits", expected: hits, detail: hitsDetail });

  // 3. Wounds
  const S = evalStatValue(weaponProfile.stats.S) + resolved.strengthMod.value;
  const T = unitProfile.T + resolved.toughnessMod.value;
  const stdWoundNeeded = woundThreshold(S, T);
  const anti = findKeyword(resolved, "anti");
  let antiThreshold = 7; // unreachable
  if (anti) {
    const targetKw = (anti.parameters?.target_keyword as string | undefined)?.toLowerCase();
    if (targetKw && targetKeywords.includes(targetKw)) {
      const threshold = Number(anti.parameters?.threshold);
      if (Number.isFinite(threshold)) antiThreshold = threshold;
    }
  }
  const critWoundThreshold = Math.min(6, antiThreshold);

  const hasLethal = !!findKeyword(resolved, "lethal-hits");
  const hitsForWoundRoll = hasLethal ? hits - critHits : hits;
  const lethalAutoWounds = hasLethal ? critHits : 0;

  const woundProbs = checkProbabilities({
    unmodifiedNeeded: stdWoundNeeded,
    modifier: resolved.woundMod.value,
    reroll: resolved.rerolls.wound?.subset ?? "none",
    autoFailOnOne: true,
    autoPassOnSix: true,
    critThreshold: critWoundThreshold,
  });
  const regularWoundsFromRoll = hitsForWoundRoll * (woundProbs.pass - woundProbs.crit);
  const critWoundsFromRoll = hitsForWoundRoll * woundProbs.crit;
  const totalRegularWounds = regularWoundsFromRoll + lethalAutoWounds;
  const hasDevastating = !!findKeyword(resolved, "devastating-wounds");
  const mortalWoundsStream = hasDevastating ? critWoundsFromRoll : 0;
  const regularWoundsForSaves = hasDevastating ? totalRegularWounds : totalRegularWounds + critWoundsFromRoll;
  const totalWounds = regularWoundsForSaves + mortalWoundsStream;
  stages.push({
    name: "wounds",
    expected: totalWounds,
    detail: `S${S} vs T${T} → need ${stdWoundNeeded}+, anti ${antiThreshold <= 6 ? `${antiThreshold}+ (active)` : "n/a"}, P(wound)=${woundProbs.pass.toFixed(4)} (${critWoundsFromRoll.toFixed(4)} crit), lethal ${hasLethal ? "+" + lethalAutoWounds.toFixed(4) : "—"}, devastating ${hasDevastating ? mortalWoundsStream.toFixed(4) + " MW" : "—"}`,
  });

  // 4. Saves
  const apMod = resolved.apMod.value;
  const AP = weaponProfile.stats.AP + apMod;
  const saveMod = resolved.saveMod.value;
  const armorTargetRaw = unitProfile.Sv - AP - saveMod;
  // Cover is a hit penalty (11e), applied in the hits stage above — it no
  // longer touches the save here.
  const armorFinal = clamp(armorTargetRaw, 2, 7);
  // The unit's printed invuln (from the profile) and any ability-granted
  // invuln combine best-wins (lowest threshold). Invuln bypasses AP, so the
  // final save is min(armor-after-AP, effective-invuln).
  // Attack-scoped invuln (issue #87): a ranged-/melee-only save applies only to
  // that attack type; fall back to the unconditional invuln_sv when unscoped.
  const scopedInvuln = isMelee ? unitProfile.invuln_sv_melee : unitProfile.invuln_sv_ranged;
  const printedInvuln = scopedInvuln ?? unitProfile.invuln_sv ?? null;
  const abilityInvuln = resolved.invulnerable?.threshold ?? null;
  const effectiveInvuln =
    printedInvuln !== null && abilityInvuln !== null
      ? Math.min(printedInvuln, abilityInvuln)
      : (printedInvuln ?? abilityInvuln);
  const effectiveSaveTarget =
    effectiveInvuln !== null ? Math.min(armorFinal, effectiveInvuln) : armorFinal;

  const saveProbs = checkProbabilities({
    unmodifiedNeeded: effectiveSaveTarget,
    modifier: 0,
    reroll: resolved.rerolls.save?.subset ?? "none",
    autoFailOnOne: true,
    autoPassOnSix: false,
    critThreshold: 7,
  });
  const pSaved = effectiveSaveTarget >= 7 ? 0 : saveProbs.pass;
  const unsaved = regularWoundsForSaves * (1 - pSaved);
  stages.push({
    name: "unsaved",
    expected: unsaved,
    detail: `Sv${unitProfile.Sv}+, AP${signed(AP)}${apMod !== 0 ? ` (apmod ${signed(apMod)})` : ""}${saveMod !== 0 ? `, savemod ${signed(saveMod)}` : ""}${abilityInvuln !== null ? `, invuln ${abilityInvuln}+ (ability)` : ""} → effective ${effectiveSaveTarget}+ (P(save)=${pSaved.toFixed(4)})`,
  });

  // 5. Damage
  const baseD = evalStatValue(weaponProfile.stats.D);
  const melta = findKeyword(resolved, "melta");
  const meltaBonus = melta && halfRange ? evalStatValue(melta.parameters?.value) : 0;
  const beforeReduction = Math.max(0, baseD + meltaBonus + resolved.damageMod.value);
  const damageReduction = resolved.damageReduction.value;
  // 10e damage-reduction abilities always carry the canonical "to a minimum
  // of 1" clause, so the floor lives in the math, not the data. The clause
  // only applies when damage-reduction is active — without it, a D1 weapon
  // with a -1 attacker damage-mod still produces 0 damage.
  const damagePerHit =
    damageReduction > 0 ? Math.max(1, beforeReduction - damageReduction) : beforeReduction;
  const damageMain = unsaved * damagePerHit;
  const damageMortal = mortalWoundsStream * damagePerHit;
  const damage = damageMain + damageMortal;
  stages.push({
    name: "damage",
    expected: damage,
    detail: `D ${baseD}${meltaBonus ? ` + Melta ${meltaBonus} (half range)` : ""}${resolved.damageMod.value !== 0 ? ` ${signed(resolved.damageMod.value)} (mod)` : ""}${damageReduction > 0 ? ` -${damageReduction} (defender, min 1)` : ""} = ${damagePerHit} per hit; main ${damageMain.toFixed(4)}, mortal ${damageMortal.toFixed(4)}`,
  });

  // 6. FNP
  // Two scopes compose: an all-FNP fires on every unsaved wound; a mortal-FNP
  // fires only on the mortal-wound stream (e.g. Death Guard 5+ FNP vs mortals).
  // A target carrying both rolls both against mortals — independent Bernoulli
  // trials, so the surviving fractions multiply.
  const pSurviveAll = fnpSurvivalFraction(resolved.feelNoPain);
  const pSurviveMortal = fnpSurvivalFraction(resolved.feelNoPainMortal);
  const afterMain = damageMain * pSurviveAll;
  const afterMortal = damageMortal * pSurviveAll * pSurviveMortal;
  const afterFnp = afterMain + afterMortal;
  const fnpDetail = describeFnp(resolved.feelNoPain, resolved.feelNoPainMortal);
  stages.push({ name: "after-fnp", expected: afterFnp, detail: fnpDetail });

  // 7. Models killed
  const W = unitProfile.W;
  const expectedModelsKilled = W > 0 ? Math.min(targetModelCount, afterFnp / W) : 0;
  stages.push({
    name: "models-killed",
    expected: expectedModelsKilled,
    detail: `W${W} per model, ${targetModelCount} models in target; ${afterFnp.toFixed(4)} damage / ${W} = ${(afterFnp / W).toFixed(4)} (capped at ${targetModelCount})`,
  });

  return { stages, resolved };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lower-cased union of a unit's `keywords` + `faction_keywords`. */
function unitKeywordsLower(unit: Unit): string[] {
  const out: string[] = [];
  for (const k of unit.keywords ?? []) out.push(String(k).toLowerCase());
  for (const k of unit.faction_keywords ?? []) out.push(String(k).toLowerCase());
  return out;
}

function profileBuffsFor(
  attacker: AttackProfileRef,
  dataset: Dataset,
  ctx: EngineContext,
): Buff[] {
  // Resolve a profile's intrinsic keyword buffs from the attacker's OWN weapon
  // object — NEVER a dataset.weapons.get(id) re-lookup. A bare weapon id shared
  // across factions (close-combat-weapon, power-fist, lascannon, …) first-wins-
  // resolves to whichever faction bundled first, so re-resolving would feed the
  // WRONG faction's profile/keywords into buff math (issue #59). attacker.weapon
  // is authoritative and carries its full profiles + keyword references.
  const profile = attacker.weapon.profiles[attacker.profileIndex];
  if (!profile) return [];
  const out: Buff[] = [];
  for (const ref of profile.keywords ?? []) {
    const view = dataset.weaponKeywords.get(ref.keyword_id);
    if (!view) continue;
    out.push(
      ...view.getBuffs(
        ref.parameters as Record<string, unknown> | undefined,
        attacker.weapon.id,
        ctx,
      ),
    );
  }
  return out;
}

function findKeyword(
  resolved: ResolvedModifiers,
  keywordId: string,
): WeaponKeywordRef | undefined {
  return resolved.extraKeywords.find((e) => e.keywordRef.keyword_id === keywordId)?.keywordRef;
}

/** Standard 10e S-vs-T table → unmodified wound threshold (2..6). */
function woundThreshold(S: number, T: number): number {
  if (S >= 2 * T) return 2;
  if (S > T) return 3;
  if (S === T) return 4;
  if (S * 2 > T) return 5;
  return 6;
}

/** Probability a single die check passes (and the conditional crit rate). */
function checkProbabilities(args: {
  unmodifiedNeeded: number;
  modifier: number;
  reroll: "none" | "ones" | "all-failures";
  autoFailOnOne: boolean;
  autoPassOnSix: boolean;
  /** Natural roll ≥ this is a crit. Use 7 to disable crits. */
  critThreshold: number;
}): { pass: number; crit: number } {
  function outcome(face: number): { pass: number; crit: number } {
    if (args.autoFailOnOne && face === 1) return { pass: 0, crit: 0 };
    if (face >= args.critThreshold) return { pass: 1, crit: 1 };
    if (args.autoPassOnSix && face === 6) return { pass: 1, crit: 0 };
    return (face + args.modifier) >= args.unmodifiedNeeded
      ? { pass: 1, crit: 0 }
      : { pass: 0, crit: 0 };
  }

  let pass = 0;
  let crit = 0;
  for (let face = 1; face <= 6; face++) {
    const initial = outcome(face);
    if (initial.pass === 1) {
      pass += 1 / 6;
      crit += initial.crit / 6;
      continue;
    }
    // Failed initial — eligible for reroll?
    const eligible =
      args.reroll === "all-failures" || (args.reroll === "ones" && face === 1);
    if (!eligible) continue;
    // Reroll: uniform over 1..6.
    let rerollPass = 0;
    let rerollCrit = 0;
    for (let f2 = 1; f2 <= 6; f2++) {
      const second = outcome(f2);
      rerollPass += second.pass / 6;
      rerollCrit += second.crit / 6;
    }
    pass += rerollPass / 6;
    crit += rerollCrit / 6;
  }
  return { pass, crit };
}

/**
 * Mean value of a stat (number or dice expression like `"D6"`, `"2D6"`,
 * `"D3+1"`, `"D6-1"`). Unrecognised strings throw — better to crash than to
 * silently return 0 and produce a confidently wrong damage projection.
 */
function evalStatValue(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return Number(v) || 0;
  const trimmed = v.trim();
  if (trimmed === "") return 0;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return asNumber;
  const match = /^(\d*)D(\d+)([+-]\d+)?$/i.exec(trimmed);
  if (!match) throw new Error(`evalStatValue: cannot parse "${v}"`);
  const count = match[1] === "" ? 1 : Number(match[1]);
  const die = Number(match[2]);
  const offset = match[3] ? Number(match[3]) : 0;
  return count * (die + 1) / 2 + offset;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `${n}`;
  return "0";
}

/** Fraction of damage that survives a single FNP roll (1 if no FNP). */
function fnpSurvivalFraction(
  fnp: { threshold: number; dominantSource: unknown } | null,
): number {
  if (!fnp) return 1;
  const pSucc = Math.max(0, Math.min(1, (7 - fnp.threshold) / 6));
  return 1 - pSucc;
}

function describeFnp(
  all: { threshold: number; dominantSource: unknown } | null,
  mortal: { threshold: number; dominantSource: unknown } | null,
): string {
  if (!all && !mortal) return "no FNP";
  const parts: string[] = [];
  if (all) {
    const pSucc = (7 - all.threshold) / 6;
    parts.push(`FNP ${all.threshold}+ (P=${pSucc.toFixed(4)})`);
  }
  if (mortal) {
    const pSucc = (7 - mortal.threshold) / 6;
    parts.push(`FNP ${mortal.threshold}+ vs mortals (P=${pSucc.toFixed(4)})`);
  }
  return parts.join(", ");
}

function attacksDetail(
  models: number,
  per: number,
  rapidFire: number,
  blast: number,
): string {
  const parts = [`${models} × ${per}`];
  if (rapidFire) parts.push(`+ Rapid Fire ${rapidFire} (half range)`);
  if (blast) parts.push(`+ Blast ${blast}/model`);
  return parts.join(" ");
}

let _embeddedDataset: Dataset | null = null;
function lazyEmbeddedDataset(): Dataset {
  if (!_embeddedDataset) _embeddedDataset = Dataset.embedded();
  return _embeddedDataset;
}

export type { Phase };
