/**
 * Linked views over the richly-connected entity types. Each wraps a raw
 * generated record and resolves its relationships lazily against the owning
 * {@link Dataset}; the full underlying record is always available via `.raw`.
 *
 * @packageDocumentation
 */
import type {
  AbilityDSLEntry,
  Faction,
  Phase,
  Unit,
  WargearOption,
  Weapon,
  WeaponKeyword,
} from "../generated.js";
import type { Buff, BuffSource, EngineContext } from "../cruncher/buffs.js";
import { buffsFromKeyword } from "../cruncher/from-keyword.js";
import {
  effectToBuffs,
  type EffectTranslation,
  type TranslationPerspective,
} from "../cruncher/from-dsl.js";
import type { Dataset } from "./dataset.js";
import { describeAbility, type AbilityAppliesTo } from "../translate/effect.js";
import { unitMatchesAppliesTo } from "../scope.js";

/** A unit, linked to its faction, weapons, and abilities. */
export class UnitView {
  constructor(
    /** The full generated `Unit` record. */
    readonly raw: Unit,
    private readonly ds: Dataset,
  ) {}

  get id(): string {
    return this.raw.id;
  }

  get name(): string {
    return this.raw.name;
  }

  get factionId(): string {
    return this.raw.faction_id;
  }

  get role(): Unit["role"] {
    return this.raw.role;
  }

  get keywords(): readonly string[] {
    return this.raw.keywords ?? [];
  }

  get factionKeywords(): readonly string[] {
    return this.raw.faction_keywords ?? [];
  }

  get modelCount(): Unit["model_count"] {
    return this.raw.model_count;
  }

  get points(): Unit["points"] {
    return this.raw.points;
  }

  /** All stat profiles for this unit (at least one is always present). */
  get profiles(): readonly Unit["profiles"][number][] {
    return this.raw.profiles;
  }

  get profileCount(): number {
    return this.raw.profiles.length;
  }

  /** The unit's faction, or `undefined` if its `faction_id` is unknown. */
  get faction(): FactionView | undefined {
    return this.ds.factions.get(this.raw.faction_id);
  }

  /**
   * Weapons referenced by `weapon_ids`, resolved within the unit's own faction —
   * a bare id shared across factions (e.g. `close-combat-weapon`) resolves to the
   * wielder's own copy (issue #59), falling back to global first-wins only for a
   * genuinely cross-faction id. Unresolved ids are skipped.
   */
  get weapons(): WeaponView[] {
    return resolveAll(
      this.raw.weapon_ids,
      (id) => this.ds.weapons.getInFaction(id, this.raw.faction_id) ?? this.ds.weapons.getAny(id),
    );
  }

  /** Abilities referenced by `ability_ids`; unresolved ids are skipped. */
  get abilities(): AbilityView[] {
    return resolveAll(
      this.raw.ability_ids,
      // Resolve within the unit's faction first — an ability_id shared across
      // factions has per-faction copies that diverge. The fallback catches the
      // faction-less `_core` pool (and any id absent from this faction's
      // enrichment).
      (id) => this.ds.abilities.getInFaction(id, this.raw.faction_id) ?? this.ds.abilities.getAny(id),
    );
  }

  /** Wargear options (weapon swaps, add-ons, choices) authored for this unit. */
  get wargearOptions(): WargearOption[] {
    return this.ds.wargearOptionsOf(this.raw);
  }

  /**
   * The stat profile at index `i` (default 0). Returns the schema-generated
   * profile object directly so callers can feed it straight to the engine
   * without an intermediate wrapper.
   */
  profileAt(i = 0): Unit["profiles"][number] {
    const profile = this.raw.profiles[i];
    if (profile === undefined) {
      throw new RangeError(
        `UnitView(${this.raw.id}).profileAt(${i}): only ${this.raw.profiles.length} profile(s) defined`,
      );
    }
    return profile;
  }
}

/**
 * An ability, linked to the phases it acts in and the units that have it.
 *
 * Phases are not stored on the ability — they live in `phase-mappings` records.
 *
 * @example
 * units.find("Kharn")!.abilities
 *   .filter(a => a.phases.includes("shooting"));
 */
export class AbilityView {
  constructor(
    /** The full generated ability record. */
    readonly raw: AbilityDSLEntry,
    private readonly ds: Dataset,
  ) {}

  /** The ability's id (`ability_id` in the raw record). */
  get id(): string {
    return this.raw.ability_id;
  }

  get name(): string {
    return this.raw.name;
  }

  /**
   * Generated plain-English approximation of this ability's effect + scope,
   * rendered from the DSL by the conformance-pinned describer
   * (`translate/effect.ts`). The dataset carries no rules prose; this is the
   * displayable stand-in.
   */
  describe(): string {
    return describeAbility(this.raw);
  }

  /** Game phases this ability acts in, unioned across its phase-mappings. */
  get phases(): Phase[] {
    return this.ds.phasesFor("ability", this.raw.ability_id);
  }

  /** Units that list this ability in their `ability_ids`. */
  get units(): UnitView[] {
    return this.ds.unitsWithAbility(this.raw.ability_id);
  }

  /**
   * The curated `applies_to` keyword filter, or `undefined` when this ability
   * declares no resolvable unit scope. When present, it names which datasheet
   * units the ability benefits — the contract for roster-side highlighting
   * (e.g. a detachment rule that only buffs `POSSESSED` units).
   */
  get appliesTo(): AbilityAppliesTo | undefined {
    return this.raw.applies_to ?? undefined;
  }

  /**
   * Whether this ability's `applies_to` scope includes `unit` — true iff the
   * unit carries every `required_keywords` entry and no `excluded_keywords`,
   * across its `keywords` + `faction_keywords`. Always `false` when the ability
   * has no `applies_to` (no resolvable scope → no highlight). Pinned by the
   * `conformance/applies-to` corpus.
   */
  affectsUnit(unit: UnitView): boolean {
    return unitMatchesAppliesTo(this.raw.applies_to, unit.raw);
  }

  /**
   * The subset of `candidates` (typically a roster's units) this ability's
   * `applies_to` scope benefits, preserving input order. Empty when the ability
   * declares no scope.
   */
  affectedUnits(candidates: UnitView[]): UnitView[] {
    return candidates.filter((u) => this.affectsUnit(u));
  }

  /**
   * Buff stack this ability contributes against `context`, with provenance
   * tagged via `source` (the caller knows whether this ability is being read
   * as army, detachment, unit, leader, etc.). DSL branches the buff layer
   * can't auto-apply are dropped here; call {@link describeBuffs} if you
   * also want the diagnostics. `perspective` defaults to `"attacker"`; pass
   * `"target"` to translate the ability as a defensive buff (FNP, T/Sv
   * stat-mods, save rerolls, incoming hit penalties).
   */
  getBuffs(
    source: BuffSource,
    context?: EngineContext,
    perspective: TranslationPerspective = "attacker",
  ): Buff[] {
    return this.describeBuffs(source, context, perspective).applied;
  }

  /**
   * Full DSL→Buff translation, including the `unsupported` list of effect
   * fragments the buff layer can't model. The SPA renders these as warnings
   * so users see which abilities have effects that need a manual toggle.
   */
  describeBuffs(
    source: BuffSource,
    context?: EngineContext,
    perspective: TranslationPerspective = "attacker",
  ): EffectTranslation {
    const ctx: EngineContext = context ?? { phase: "shooting" };
    const translated = effectToBuffs(this.raw.effect, source, ctx, perspective);
    // A range-scoped ability (DSL `scope.range_inches`, e.g. a "within 18\""
    // reroll) gates on distance to the target. Stamp it here rather than in the
    // effect translator so the `effect-translation` corpus (bare effects) is
    // unaffected; the gate is permissive until a caller sets `distanceInches`.
    const range = (this.raw.scope as { range_inches?: number } | undefined)?.range_inches;
    if (typeof range !== "number") return translated;
    const gate = (b: Buff): Buff => ({
      ...b,
      applicableWhen: { ...b.applicableWhen, maxRangeInches: range },
    });
    return {
      applied: translated.applied.map(gate),
      unsupported: translated.unsupported,
      activatable: translated.activatable.map((a) => ({ ...a, buffs: a.buffs.map(gate) })),
    };
  }
}

/** A weapon, linked to the units that carry it. */
export class WeaponView {
  constructor(
    /** The full generated `Weapon` record. */
    readonly raw: Weapon,
    private readonly ds: Dataset,
  ) {}

  get id(): string {
    return this.raw.id;
  }

  get name(): string {
    return this.raw.name;
  }

  get type(): string {
    return this.raw.type;
  }

  /** All stat profiles for this weapon (at least one is always present). */
  get profiles(): readonly Weapon["profiles"][number][] {
    return this.raw.profiles;
  }

  get profileCount(): number {
    return this.raw.profiles.length;
  }

  /** Units that list this weapon in their `weapon_ids`. */
  get units(): UnitView[] {
    return this.ds.unitsWithWeapon(this.raw.id);
  }

  /** The stat profile at index `i` (default 0). */
  profileAt(i = 0): Weapon["profiles"][number] {
    const profile = this.raw.profiles[i];
    if (profile === undefined) {
      throw new RangeError(
        `WeaponView(${this.raw.id}).profileAt(${i}): only ${this.raw.profiles.length} profile(s) defined`,
      );
    }
    return profile;
  }

  /**
   * Catalog views for each keyword referenced by profile `i`, paired with the
   * reference-site parameters. Unresolved keyword ids are skipped.
   */
  keywordsAt(
    i = 0,
  ): { keyword: WeaponKeywordView; parameters: Record<string, unknown> | undefined }[] {
    const profile = this.profileAt(i);
    const refs = profile.keywords ?? [];
    const out: { keyword: WeaponKeywordView; parameters: Record<string, unknown> | undefined }[] = [];
    for (const ref of refs) {
      const view = this.ds.weaponKeywords.get(ref.keyword_id);
      if (!view) continue;
      out.push({
        keyword: view,
        parameters: ref.parameters as Record<string, unknown> | undefined,
      });
    }
    return out;
  }

  /**
   * Buffs contributed by profile `i`'s intrinsic keywords against `context` —
   * the natural "what does this profile bring on its own?" call the engine
   * makes automatically before adding ability/manual buffs.
   */
  profileBuffs(i: number | undefined, context: EngineContext): Buff[] {
    const index = i ?? 0;
    const out: Buff[] = [];
    for (const { keyword, parameters } of this.keywordsAt(index)) {
      out.push(
        ...buffsFromKeyword({
          keywordId: keyword.id,
          weaponId: this.raw.id,
          effect: keyword.raw.effect,
          ...(parameters !== undefined ? { parameters } : {}),
          context,
        }),
      );
    }
    return out;
  }
}

/**
 * A weapon-keyword catalog entry, linked to the weapons whose profiles
 * reference it. Exposes the keyword's mechanical effect as a buff stack
 * via {@link getBuffs}.
 */
export class WeaponKeywordView {
  constructor(
    /** The full generated `WeaponKeyword` record. */
    readonly raw: WeaponKeyword,
    private readonly ds: Dataset,
  ) {}

  get id(): string {
    return this.raw.id;
  }

  get name(): string {
    return this.raw.name;
  }

  /** Weapons whose profiles reference this keyword id. */
  get weapons(): WeaponView[] {
    return this.ds.weaponsWithKeyword(this.raw.id);
  }

  /**
   * Buff contributions from this catalog entry, for one reference site:
   * pass the keyword's `parameters` (e.g. `{ value: 1 }` for Sustained Hits 1)
   * along with the `weaponId` that's carrying it (used as the buff source)
   * and the engine `context` (e.g. attacker stationary?).
   */
  getBuffs(
    parameters: Record<string, unknown> | undefined,
    weaponId: string,
    context: EngineContext,
  ): Buff[] {
    return buffsFromKeyword({
      keywordId: this.raw.id,
      weaponId,
      effect: this.raw.effect,
      ...(parameters !== undefined ? { parameters } : {}),
      context,
    });
  }
}

/** A faction, linked to its units and the records scoped to it. */
export class FactionView {
  constructor(
    /** The full generated `Faction` record. */
    readonly raw: Faction,
    private readonly ds: Dataset,
  ) {}

  get id(): string {
    return this.raw.id;
  }

  get name(): string {
    return this.raw.name;
  }

  /** URL to the faction's logo/emblem image, or `undefined` if unset. */
  get logoUrl(): string | undefined {
    return this.raw.logo_url;
  }

  /** Units whose `faction_id` is this faction (may be empty for successors). */
  get units(): UnitView[] {
    return this.ds.units.byFaction(this.raw.id);
  }

  /** Faction-scoped abilities (abilities whose `faction_id` is this faction). */
  get abilities(): AbilityView[] {
    return this.ds.abilities.byFaction(this.raw.id);
  }

  /** Distinct weapons carried by this faction's units. */
  get weapons(): WeaponView[] {
    const seen = new Set<string>();
    const out: WeaponView[] = [];
    for (const unit of this.units) {
      for (const weapon of unit.weapons) {
        if (seen.has(weapon.id)) continue;
        seen.add(weapon.id);
        out.push(weapon);
      }
    }
    return out;
  }
}

/** Resolve a list of ids, dropping any that don't resolve. */
function resolveAll<V>(ids: string[] | undefined, get: (id: string) => V | undefined): V[] {
  const out: V[] = [];
  for (const id of ids ?? []) {
    const v = get(id);
    if (v !== undefined) out.push(v);
  }
  return out;
}
