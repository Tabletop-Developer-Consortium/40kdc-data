/**
 * {@link Dataset} ties the embedded records together: it owns every
 * {@link Collection}, builds the cross-entity indexes once, and is the `this`
 * the linked views resolve against.
 *
 * @packageDocumentation
 */
import type {
  AlliedRule,
  DeploymentPattern,
  Detachment,
  Enhancement,
  ForceDisposition,
  GameEvent,
  GameVersion,
  HullShape,
  InteractionFlag,
  LeaderAttachment,
  Mission,
  MissionMatchup,
  Phase,
  ResourcePool,
  SecondaryCard,
  Stratagem,
  TargetProfile,
  TerrainLayout,
  TerrainTemplate,
  Unit,
  UnitComposition,
  Wargear,
  WargearOption,
  WeaponKeyword,
  UnitKeyword,
} from "../generated.js";
import { Collection } from "./collection.js";
import {
  AbilityView,
  FactionView,
  UnitView,
  WeaponKeywordView,
  WeaponView,
} from "./entities.js";
import { emptyRawData, type RawData } from "./types.js";
import { RAW_DATA } from "./bundle.generated.js";
import { resolveLayout, type ResolvedPiece } from "../terrain/resolve.js";
import type { Buff, BuffSource, EngineContext } from "../cruncher/buffs.js";
import {
  resolveEligibleAbilities,
  type EligibilityInput,
  type EligibleAbility,
} from "../abilities-resolver/index.js";

/**
 * One toggleable buff lever for damage analysis: the contributions it adds and
 * whether it's on by default. `enabled` is `true` for buffs that always apply
 * (intrinsic keywords, unconditional abilities) and `false` for player
 * decisions — stratagems (CP cost) and activatable gates (dice-pool options,
 * `choice` branches, timing-gated activations). A consumer flips `enabled`,
 * then crunches the enabled subset; an optimizer searches it.
 *
 * @see {@link Dataset.stackableBuffsFor}
 */
export type StackableBuff = {
  /** Stable toggle id (stable across re-enumeration of the same input). */
  id: string;
  /** Human label for the lever. */
  label: string;
  /** Contributions this lever adds when enabled (≥1). */
  buffs: Buff[];
  /** Default selection state. */
  enabled: boolean;
  /** Where the lever came from. */
  source: BuffSource;
  /** Id of the mutually-limited {@link StackableBuffGroup} this belongs to, if any. */
  group?: string;
};

/** A pool of {@link StackableBuff} levers limited to `maxActivations` at once. */
export type StackableBuffGroup = {
  id: string;
  label: string;
  maxActivations: number;
};

/**
 * One reactive ability resolved for event dispatch: the ability's id, the
 * {@link GameEvent} it fires on, the units that carry it (sorted; empty for
 * faction/detachment rules), and the full (non-null) `trigger` block.
 *
 * @see {@link Dataset.reactiveTriggers}
 * @see {@link Dataset.triggerIndex}
 */
export type ReactiveTrigger = {
  abilityId: string;
  event: GameEvent;
  unitIds: string[];
  trigger: NonNullable<RawData["abilities"][number]["trigger"]>;
};

/** The whole dataset, with linked accessors over every entity collection. */
export class Dataset {
  // Richly-linked collections.
  readonly units: Collection<Unit, UnitView>;
  readonly weapons: Collection<RawData["weapons"][number], WeaponView>;
  readonly weaponKeywords: Collection<WeaponKeyword, WeaponKeywordView>;
  readonly factions: Collection<RawData["factions"][number], FactionView>;
  readonly abilities: Collection<RawData["abilities"][number], AbilityView>;

  // Id-bearing collections without bespoke views (records returned as-is).
  readonly unitKeywords: Collection<UnitKeyword, UnitKeyword>;
  readonly targetProfiles: Collection<TargetProfile, TargetProfile>;
  readonly detachments: Collection<Detachment, Detachment>;
  readonly alliedRules: Collection<AlliedRule, AlliedRule>;
  readonly enhancements: Collection<Enhancement, Enhancement>;
  readonly stratagems: Collection<Stratagem, Stratagem>;
  readonly wargearOptions: Collection<WargearOption, WargearOption>;
  readonly wargear: Collection<Wargear, Wargear>;
  readonly missions: Collection<Mission, Mission>;
  readonly missionMatchups: Collection<MissionMatchup, MissionMatchup>;
  readonly missionCards: Collection<SecondaryCard, SecondaryCard>;
  readonly deploymentPatterns: Collection<DeploymentPattern, DeploymentPattern>;
  readonly forceDispositions: Collection<ForceDisposition, ForceDisposition>;
  readonly terrainTemplates: Collection<TerrainTemplate, TerrainTemplate>;
  readonly terrainLayouts: Collection<TerrainLayout, TerrainLayout>;
  readonly hullShapes: Collection<HullShape, HullShape>;
  readonly resourcePools: Collection<ResourcePool, ResourcePool>;

  // Id-less collections, exposed as plain arrays.
  readonly leaderAttachments: readonly LeaderAttachment[];
  readonly unitCompositions: readonly UnitComposition[];
  readonly gameVersions: readonly GameVersion[];
  readonly interactionFlags: readonly InteractionFlag[];
  readonly phaseMappings: readonly RawData["phaseMappings"][number][];

  /** `source_type:source_id` → unioned phases. */
  private readonly phaseIndex = new Map<string, Phase[]>();
  /** ability id → units that list it. */
  private readonly unitsByAbility = new Map<string, Unit[]>();
  /** weapon id → units that list it. */
  private readonly unitsByWeapon = new Map<string, Unit[]>();
  /** weapon-keyword id → weapons whose profiles reference it. */
  private readonly weaponsByKeyword = new Map<string, RawData["weapons"][number][]>();
  /** lowercased keyword → units carrying it (in `keywords` or `faction_keywords`). */
  private readonly unitsByKeyword = new Map<string, Unit[]>();
  /** `faction_id::unit_id` → wargear options authored for it (declared order preserved). */
  private readonly wargearOptionsByUnit = new Map<string, WargearOption[]>();
  /** `faction_id::unit_id` → the unit-composition authored for it. */
  private readonly compositionByUnit = new Map<string, UnitComposition>();

  constructor(raw: RawData = emptyRawData()) {
    this.units = new Collection({
      items: raw.units,
      idOf: (u) => u.id,
      // The same unit id is shared across factions (e.g. ministorum-priest);
      // keep each faction's copy, collapse only true within-faction duplicates.
      dedupeKeyOf: (u) => `${u.faction_id}::${u.id}`,
      nameOf: (u) => u.name,
      aliasesOf: (u) => u.aliases,
      factionOf: (u) => u.faction_id,
      // Per-faction copies of a shared chassis genuinely diverge (points,
      // keywords, profiles), so a faction-less get() of a shared id is a bug.
      guardUnscoped: true,
      entityLabel: "unit",
      wrap: (u) => new UnitView(u, this),
    });
    this.weapons = new Collection({
      items: raw.weapons,
      idOf: (w) => w.id,
      // A bare weapon id is shared across factions with divergent stats (each
      // faction file defines its own e.g. "close-combat-weapon"); key on
      // (faction_id, id) so every faction's copy is retained and a unit resolves
      // its own faction's weapon (issue #59), not whichever bundled first. No
      // guardUnscoped: get()/getAny stay first-wins for the many catalog/import
      // callsites that pass an explicit id without faction context.
      dedupeKeyOf: (w) => `${w.faction_id ?? ""}::${w.id}`,
      nameOf: (w) => w.name,
      factionOf: (w) => w.faction_id,
      wrap: (w) => new WeaponView(w, this),
    });
    this.weaponKeywords = new Collection({
      items: raw.weaponKeywords,
      idOf: (k) => k.id,
      nameOf: (k) => k.name,
      wrap: (k) => new WeaponKeywordView(k, this),
    });
    this.factions = new Collection({
      items: raw.factions,
      idOf: (f) => f.id,
      nameOf: (f) => f.name,
      wrap: (f) => new FactionView(f, this),
    });
    this.abilities = new Collection({
      items: raw.abilities,
      idOf: (a) => a.ability_id,
      // An ability_id is shared across factions (each faction's enrichment
      // authors its own copy of e.g. "deadly-demise-d3", and the copies
      // legitimately diverge); key on (faction_id, id) so every faction's copy
      // is retained and a unit resolves its own faction's ability — the same
      // scheme as weapons (issue #59). `faction_id` is stamped at bundle time
      // from the enrichment directory; only the shared `_core` pool stays
      // faction-less, reachable through the getAny fallback.
      dedupeKeyOf: (a) => `${a.faction_id ?? ""}::${a.ability_id}`,
      nameOf: (a) => a.name,
      factionOf: (a) => a.faction_id,
      wrap: (a) => new AbilityView(a, this),
    });

    this.unitKeywords = idCollection(raw.unitKeywords);
    this.targetProfiles = idCollection(raw.targetProfiles, (p) => p.faction_id);
    // A detachment id is shared across factions: the generic Codex Space Marine
    // detachments are replicated into every Codex-compatible chapter/supplement
    // (each as its own faction view), so keep each faction's copy and collapse
    // only true within-faction duplicates — mirroring the unit collection. Use
    // {@link Collection.getInFaction} / {@link Collection.byFaction} when a
    // faction context is known; bare {@link Collection.get} returns whichever
    // copy was registered first.
    this.detachments = new Collection({
      items: raw.detachments,
      idOf: (d) => d.id,
      nameOf: (d) => d.name,
      dedupeKeyOf: (d) => `${d.faction_id}::${d.id}`,
      factionOf: (d) => d.faction_id,
      // Shared Space Marine detachments diverge per chapter (detachment_rule_id,
      // stratagem_ids, enhancement_ids, detachment_points), so a faction-less
      // get() of a shared id is a bug — same guard as the units collection.
      guardUnscoped: true,
      entityLabel: "detachment",
      wrap: (d) => d,
    });
    // Allied rules aren't owned by one faction (Daemonic Pact is shared by
    // Chaos Knights and CSM); `alliesFor` matches on `army_keywords_any` instead.
    this.alliedRules = idCollection(raw.alliedRules);
    this.enhancements = idCollection(raw.enhancements);
    this.stratagems = idCollection(raw.stratagems);
    this.wargearOptions = idCollection(raw.wargearOptions);
    this.wargear = idCollection(raw.wargear);
    this.missions = idCollection(raw.missions);
    this.missionMatchups = idCollection(raw.missionMatchups);
    this.missionCards = idCollection(raw.missionCards);
    this.deploymentPatterns = idCollection(raw.deploymentPatterns);
    this.forceDispositions = idCollection(raw.forceDispositions);
    this.terrainTemplates = idCollection(raw.terrainTemplates);
    this.terrainLayouts = idCollection(raw.terrainLayouts);
    this.hullShapes = idCollection(raw.hullShapes);
    this.resourcePools = idCollection(raw.resourcePools);

    this.leaderAttachments = raw.leaderAttachments;
    this.unitCompositions = raw.unitCompositions;
    this.gameVersions = raw.gameVersions;
    this.interactionFlags = raw.interactionFlags;
    this.phaseMappings = raw.phaseMappings;

    this.buildIndexes(raw);
  }

  /** The dataset built from the package's embedded data. */
  static embedded(): Dataset {
    return new Dataset(RAW_DATA);
  }

  /** Phases a source acts in, unioned across its phase-mappings. */
  phasesFor(sourceType: string, sourceId: string): Phase[] {
    return this.phaseIndex.get(`${sourceType}:${sourceId}`) ?? [];
  }

  /**
   * Resolve a terrain layout to absolute board-space vertices using this
   * dataset's embedded terrain-template catalog — the layout-id →
   * renderable-geometry hop. Mirror of Rust `Dataset::resolve_terrain`; the
   * geometry is pinned by the `terrain-resolver` conformance corpus.
   */
  resolveTerrain(layout: TerrainLayout): ResolvedPiece[] {
    // The resolver takes its own structurally-identical input types, decoupled
    // from the generated `anyOf`/newtype shapes; the underlying JSON is the same.
    return resolveLayout(layout as never, this.terrainTemplates.all as never);
  }

  /**
   * The terrain layouts a deployment pattern recommends, in declared order,
   * skipping any ids absent from the dataset.
   */
  recommendedTerrainLayouts(pattern: DeploymentPattern): TerrainLayout[] {
    return (pattern.recommended_terrain_layout_ids ?? [])
      .map((id) => this.terrainLayouts.get(id))
      .filter((l): l is TerrainLayout => l !== undefined);
  }

  /** Units that list the given ability id. */
  unitsWithAbility(abilityId: string): UnitView[] {
    return (this.unitsByAbility.get(abilityId) ?? []).map((u) => new UnitView(u, this));
  }

  /**
   * Every ability carrying a reactive {@link AbilityTrigger}, sorted by ability
   * id. Each entry names the units that list the ability (sorted; empty for
   * faction/detachment-rule abilities no unit references directly).
   */
  reactiveTriggers(): ReactiveTrigger[] {
    const out: ReactiveTrigger[] = [];
    // The abilities collection retains one copy per faction of a shared
    // ability_id; this aggregation is faction-less (ReactiveTrigger carries no
    // faction), so emit each ability id once — first registered copy wins,
    // matching the collection's own byId index.
    const seenIds = new Set<string>();
    for (const a of this.abilities.all) {
      if (seenIds.has(a.id)) continue;
      seenIds.add(a.id);
      const raw = a.raw.trigger;
      if (!raw) continue;
      // `trigger` may be a single object or an array (the ability fires on any);
      // emit one ReactiveTrigger per event so the dispatch index keys them all.
      const triggers = Array.isArray(raw) ? raw : [raw];
      const unitIds = (this.unitsByAbility.get(a.id) ?? []).map((u) => u.id).sort();
      for (const trigger of triggers) {
        if (trigger?.event == null) continue;
        out.push({ abilityId: a.id, event: trigger.event, unitIds, trigger });
      }
    }
    out.sort((x, y) => (x.abilityId < y.abilityId ? -1 : x.abilityId > y.abilityId ? 1 : 0));
    return out;
  }

  /**
   * Dispatch index for event-driven consumers: {@link GameEvent} → the reactive
   * triggers firing on it. Keys are iterated in event order and each bucket is
   * sorted by ability id, so the structure is deterministic across runs.
   */
  triggerIndex(): Map<GameEvent, ReactiveTrigger[]> {
    const grouped = new Map<GameEvent, ReactiveTrigger[]>();
    for (const rt of this.reactiveTriggers()) {
      const bucket = grouped.get(rt.event);
      if (bucket) bucket.push(rt);
      else grouped.set(rt.event, [rt]);
    }
    return new Map(
      [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  /** Units that list the given weapon id. */
  unitsWithWeapon(weaponId: string): UnitView[] {
    return (this.unitsByWeapon.get(weaponId) ?? []).map((u) => new UnitView(u, this));
  }

  /** Weapons whose profiles reference the given weapon-keyword id. */
  weaponsWithKeyword(keywordId: string): WeaponView[] {
    return (this.weaponsByKeyword.get(keywordId) ?? []).map((w) => new WeaponView(w, this));
  }

  /**
   * Units carrying the given keyword, matched case-insensitively against the
   * union of each unit's `keywords` and `faction_keywords`. Powers a list
   * builder's keyword search bar (type "Khorne" to find every Khorne unit),
   * across the whole dataset — so it also surfaces cross-faction ally pools.
   * Returns each faction's copy of a shared unit id separately.
   */
  unitsWithKeyword(keyword: string): UnitView[] {
    return (this.unitsByKeyword.get(keyword.toLowerCase()) ?? []).map((u) => new UnitView(u, this));
  }

  /**
   * The allied-rules **offered** for an army of `factionId` running the given
   * detachments. A rule applies when both its gates pass: the **army gate**
   * (`army_keywords_any` empty, or intersecting the faction's keywords) and the
   * **detachment gate** (`detachment_ids` empty, or any listed id among `detachmentIds`). Order
   * follows the allied-rules data file. The strict "every *model* carries an
   * army keyword" check (for soup lists) is a builder/validation concern — this
   * offers the candidate rules a faction qualifies for. Mirror of Rust
   * `Dataset::allies_for`; pinned by the `allies_for` conformance query.
   */
  alliesFor(factionId: string, detachmentIds: string[] = []): AlliedRule[] {
    const faction = this.factions.get(factionId);
    if (!faction) return [];
    const factionKeywords = new Set((faction.raw.keywords ?? []).map((k) => k.toLowerCase()));
    const detachmentSet = new Set(detachmentIds);
    return this.alliedRules.all.filter((rule) => {
      const armyGate =
        (rule.army_keywords_any ?? []).length === 0 ||
        (rule.army_keywords_any ?? []).some((k) => factionKeywords.has(k.toLowerCase()));
      const detachmentGate =
        (rule.detachment_ids ?? []).length === 0 ||
        (rule.detachment_ids ?? []).some((id) => detachmentSet.has(id));
      return armyGate && detachmentGate;
    });
  }

  /**
   * The unit pool an allied-rule grants, sorted by name. Starts from the rule's
   * `source_faction_id` (if set, to keep that faction's copy of shared ids) or
   * the whole dataset, then ANDs every filter the rule sets: `source_datasheet_ids`
   * (an explicit id allowlist — the primary selector for generated pools), any
   * `source_keywords`, `required_keywords` (all present), `excluded_keywords`
   * (none present), and `roles`. Empty for an unknown rule id or a pool that
   * resolves to nothing. Mirror of Rust `Dataset::ally_units_for`; pinned by the
   * `ally_units_for` conformance query.
   */
  allyUnitsFor(ruleId: string): UnitView[] {
    const rule = this.alliedRules.get(ruleId);
    if (!rule) return [];
    const base = rule.source_faction_id
      ? this.units.byFaction(rule.source_faction_id)
      : this.units.all;
    const sourceKeywords = (rule.source_keywords ?? []).map((k) => k.toLowerCase());
    const required = (rule.required_keywords ?? []).map((k) => k.toLowerCase());
    const excluded = (rule.excluded_keywords ?? []).map((k) => k.toLowerCase());
    const roles = new Set(rule.roles ?? []);
    const datasheetIds = new Set(rule.source_datasheet_ids ?? []);
    const out = base.filter((u) => {
      const have = unitKeywordSet(u.raw);
      if (datasheetIds.size > 0 && !datasheetIds.has(u.raw.id)) return false;
      if (sourceKeywords.length > 0 && !sourceKeywords.some((k) => have.has(k))) return false;
      if (required.length > 0 && !required.every((k) => have.has(k))) return false;
      if (excluded.some((k) => have.has(k))) return false;
      if (roles.size > 0 && !(u.raw.role && roles.has(u.raw.role))) return false;
      return true;
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Wargear options authored for the given unit, in declared order. Scoped to
   * the unit's own faction: a chassis shared across factions (e.g.
   * `chaos-terminators` in World Eaters *and* Emperors Children) reuses the same
   * option ids for different swaps, so the lookup keys on `(faction_id, unit_id)`
   * — never the union across factions. Mirror of Rust `Dataset::wargear_options_of`.
   * Empty for a unit with no options.
   */
  wargearOptionsOf(unit: Unit): WargearOption[] {
    return this.wargearOptionsByUnit.get(`${unit.faction_id}::${unit.id}`) ?? [];
  }

  /**
   * The unit-composition authored for the given unit, faction-scoped exactly
   * like {@link wargearOptionsOf}: shared chassis carry a distinct composition
   * per faction under one `unit_id`, so the lookup keys on `(faction_id,
   * unit_id)` rather than the faction-blind `unitCompositions.find(...)`.
   * `undefined` when the unit has no composition.
   */
  unitCompositionOf(unit: Unit): UnitComposition | undefined {
    return this.compositionByUnit.get(`${unit.faction_id}::${unit.id}`);
  }

  /**
   * Leaders whose leader-attachment data lists `bodyguardUnitId` among its
   * eligible body units, sorted by name. The attachment is stored on the
   * leader pointing down to its bodyguards, so answering "which leaders can
   * attach to this unit?" means scanning the attachment list. Returns an empty
   * array for a unit that no leader can attach to (including leader units).
   */
  leadersAttachableTo(bodyguardUnitId: string): UnitView[] {
    return this.leaderAttachments
      .filter((la) => la.eligible_bodyguard_ids.includes(bodyguardUnitId))
      // Attachment data is faction-agnostic (no faction context here); accept
      // first-wins for a shared leader/bodyguard chassis via getAny.
      .map((la) => this.units.getAny(la.leader_id))
      .filter((u): u is UnitView => u !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The inverse of {@link leadersAttachableTo}: the body units the given
   * leader can attach to, sorted by name. Scans the same leader-attachment
   * data from the leader's side (`leader_id` matches; resolve each
   * `eligible_bodyguard_ids` entry), deduped by id. Empty for a non-leader
   * unit. Together the two queries give the bidirectional attachment graph the
   * SPA needs to offer a partner dropdown from either end.
   */
  bodyguardsAttachableFrom(leaderUnitId: string): UnitView[] {
    const seen = new Set<string>();
    const out: UnitView[] = [];
    for (const la of this.leaderAttachments) {
      if (la.leader_id !== leaderUnitId) continue;
      for (const bodyguardId of la.eligible_bodyguard_ids) {
        if (seen.has(bodyguardId)) continue;
        const unit = this.units.getAny(bodyguardId);
        if (!unit) continue;
        seen.add(bodyguardId);
        out.push(unit);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Enumerate every ability that could apply to the given unit in `phase`,
   * grouped by source. The SPA uses this to render the abilities pane.
   */
  eligibleAbilities(input: EligibilityInput, phase: Phase): EligibleAbility[] {
    return resolveEligibleAbilities(this, input, phase);
  }

  /**
   * Attacker-perspective {@link Buff} stack for a (unit, phase) combination:
   * intrinsic weapon-profile keywords plus every eligible ability whose DSL
   * effect translates to an attacker-side buff (army, detachment, unit,
   * attached members, support, plus any stratagems the caller has opted into).
   *
   * The result includes only buffs the buff layer can express today — the
   * `unsupported` half of the DSL→Buff translation is dropped here so callers
   * who just want the stack don't need to thread diagnostics through. Use
   * {@link AbilityView.describeBuffs} when you need the diagnostics for an
   * individual ability. Symmetric to {@link defensiveBuffsFor}, which walks
   * the same eligibility set under target perspective.
   */
  buffsFor(
    input: EligibilityInput & {
      weaponProfiles?: { weaponId: string; profileIndex: number }[];
      /** Stratagem ids the caller has opted into spending CP on. */
      optedInStratagemIds?: string[];
    },
    context: EngineContext,
  ): Buff[] {
    return this.collectBuffs(input, context, "attacker");
  }

  /**
   * Defender-perspective buff stack for the chosen unit: walks the same
   * eligible-abilities set as {@link buffsFor} but translates each ability's
   * DSL effect as defensive (FNP, save mods from `stat-modifier Sv`,
   * toughness mods from `stat-modifier T`, save rerolls, incoming hit
   * penalties from `bs-modifier`). Use this when the chosen unit is being
   * crunched as the *target* — the engine reads `feelNoPain`/`saveMod`/
   * `toughnessMod` out of `resolveBuffs` so wiring the result into `crunch`
   * just means concatenating onto the existing `buffs` array.
   *
   * `weaponProfiles` are ignored under target perspective — weapon-keyword
   * effects ride with the firing weapon, not the receiving unit.
   */
  defensiveBuffsFor(
    input: EligibilityInput & { optedInStratagemIds?: string[] },
    context: EngineContext,
  ): Buff[] {
    return this.collectBuffs(input, context, "target");
  }

  /**
   * Enumerate every attacker-side buff a unit could stack in `context` as a
   * list of toggleable levers, plus the activation groups that limit them.
   *
   * Unlike {@link buffsFor} — which returns only the buffs that auto-apply —
   * this surfaces the *player decisions* too: stratagems, and the activatable
   * gates the DSL models as dice-pool options, `choice` branches, or
   * timing-gated activations (e.g. Blessings of Khorne's three keyword grants).
   * Each lever carries `enabled` (its default state) and, where it's part of a
   * limited pool, a `group` id whose {@link StackableBuffGroup} caps how many
   * can fire at once. The intended loop:
   *
   * ```ts
   * const { buffs } = ds.stackableBuffsFor(input, ctx);
   * const chosen = buffs.filter(b => b.enabled).flatMap(b => b.buffs);
   * crunch({ ...profiles, buffs: chosen, context: ctx }, ds);
   * ```
   *
   * Target/phase conditions a lever still carries (e.g. "vs Infantry") ride on
   * each buff's `applicableWhen`, so toggling it on is always safe — the
   * resolver gates it per-target.
   */
  stackableBuffsFor(
    input: EligibilityInput & {
      weaponProfiles?: { weaponId: string; profileIndex: number }[];
    },
    context: EngineContext,
  ): { buffs: StackableBuff[]; groups: StackableBuffGroup[] } {
    const buffs: StackableBuff[] = [];
    const groups = new Map<string, StackableBuffGroup>();

    // Surface the attachment fact to the DSL translator so `is-attached` /
    // `model-is-leader` conditions can evaluate. Clone — never mutate the
    // caller's context. An explicitly-set flag wins over the derivation.
    const ctx: EngineContext = {
      ...context,
      attackerAttached: context.attackerAttached ?? (input.attachedUnitIds?.length ?? 0) > 0,
    };

    // Intrinsic weapon-profile keywords — always on.
    for (const ref of input.weaponProfiles ?? []) {
      const weapon = this.weapons.get(ref.weaponId);
      if (!weapon) continue;
      const wk = weapon.profileBuffs(ref.profileIndex, ctx);
      if (wk.length === 0) continue;
      buffs.push({
        id: `weapon:${ref.weaponId}:${ref.profileIndex}`,
        label: `${weapon.name} keywords`,
        buffs: wk,
        enabled: true,
        source: wk[0].source,
      });
    }

    for (const entry of this.eligibleAbilities(input, ctx.phase)) {
      const source = bufferSourceFromEligible(entry);
      const { applied, activatable } = entry.ability.describeBuffs(source, ctx, "attacker");
      // Stratagems cost CP — opt-in, not on by default.
      const isStratagem = entry.source.kind === "detachment-stratagem";

      if (applied.length > 0) {
        buffs.push({
          id: `${entry.source.kind}:${entry.ability.id}`,
          label: entry.ability.name,
          buffs: applied,
          enabled: !isStratagem,
          source,
        });
      }

      for (const act of activatable) {
        let groupId: string | undefined;
        if (act.group) {
          groupId = act.group.id;
          if (!groups.has(groupId)) {
            groups.set(groupId, {
              id: groupId,
              label: entry.ability.name,
              maxActivations: act.group.maxActivations,
            });
          }
        }
        buffs.push({
          id: act.id,
          label: `${entry.ability.name} — ${act.label}`,
          buffs: act.buffs,
          enabled: false,
          source,
          group: groupId,
        });
      }
    }

    return { buffs, groups: [...groups.values()] };
  }

  /** Shared implementation for buffsFor / defensiveBuffsFor. */
  private collectBuffs(
    input: EligibilityInput & {
      weaponProfiles?: { weaponId: string; profileIndex: number }[];
      optedInStratagemIds?: string[];
    },
    context: EngineContext,
    perspective: "attacker" | "target",
  ): Buff[] {
    const out: Buff[] = [];

    // Surface the attachment fact to the DSL translator (see stackableBuffsFor).
    // Clone — never mutate the caller's context; explicit flag wins.
    const ctx: EngineContext = {
      ...context,
      attackerAttached: context.attackerAttached ?? (input.attachedUnitIds?.length ?? 0) > 0,
    };

    // Weapon-profile keywords are attacker-only.
    if (perspective === "attacker") {
      for (const ref of input.weaponProfiles ?? []) {
        const weapon = this.weapons.get(ref.weaponId);
        if (!weapon) continue;
        out.push(...weapon.profileBuffs(ref.profileIndex, ctx));
      }
    }

    const optedIn = new Set(input.optedInStratagemIds ?? []);
    for (const entry of this.eligibleAbilities(input, ctx.phase)) {
      if (entry.source.kind === "detachment-stratagem" && !optedIn.has(entry.source.stratagemId)) {
        continue;
      }
      const source = bufferSourceFromEligible(entry);
      out.push(...entry.ability.getBuffs(source, ctx, perspective));
    }

    return out;
  }

  private buildIndexes(raw: RawData): void {
    for (const pm of raw.phaseMappings) {
      const key = `${pm.source_type}:${pm.source_id}`;
      const existing = this.phaseIndex.get(key) ?? [];
      for (const phase of pm.phases) {
        if (!existing.includes(phase)) existing.push(phase);
      }
      this.phaseIndex.set(key, existing);
    }
    for (const unit of raw.units) {
      for (const abilityId of unit.ability_ids ?? []) push(this.unitsByAbility, abilityId, unit);
      for (const weaponId of unit.weapon_ids ?? []) push(this.unitsByWeapon, weaponId, unit);
      // Index every keyword the unit carries (unit keywords ∪ faction keywords),
      // lowercased, deduped per-unit so an overlap doesn't list the unit twice.
      const seenKw = new Set<string>();
      for (const kw of [...(unit.keywords ?? []), ...(unit.faction_keywords ?? [])]) {
        const key = kw.toLowerCase();
        if (seenKw.has(key)) continue;
        seenKw.add(key);
        push(this.unitsByKeyword, key, unit);
      }
    }
    for (const option of raw.wargearOptions) {
      push(this.wargearOptionsByUnit, `${option.faction_id}::${option.unit_id}`, option);
    }
    for (const comp of raw.unitCompositions) {
      // A unit has at most one composition per faction; keep the first if the
      // data ever doubles (integrity flags within-faction duplicates).
      const key = `${comp.faction_id}::${comp.unit_id}`;
      if (!this.compositionByUnit.has(key)) this.compositionByUnit.set(key, comp);
    }
    const seenByKeyword = new Map<string, Set<string>>();
    for (const weapon of raw.weapons) {
      for (const profile of weapon.profiles) {
        for (const ref of profile.keywords ?? []) {
          let seen = seenByKeyword.get(ref.keyword_id);
          if (!seen) {
            seen = new Set();
            seenByKeyword.set(ref.keyword_id, seen);
          }
          if (seen.has(weapon.id)) continue;
          seen.add(weapon.id);
          push(this.weaponsByKeyword, ref.keyword_id, weapon);
        }
      }
    }
  }
}

/** Build a passthrough collection for an id-bearing record type. */
function idCollection<T extends { id: string }>(
  items: T[],
  factionOf?: (item: T) => string | null | undefined,
): Collection<T, T> {
  return new Collection<T, T>({
    items,
    idOf: (i) => i.id,
    nameOf: (i) => (i as { name?: string }).name,
    factionOf,
    wrap: (i) => i,
  });
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Lowercased union of a unit's `keywords` and `faction_keywords`, for membership tests. */
function unitKeywordSet(unit: Unit): Set<string> {
  const out = new Set<string>();
  for (const k of unit.keywords ?? []) out.add(k.toLowerCase());
  for (const k of unit.faction_keywords ?? []) out.add(k.toLowerCase());
  return out;
}

/** Map an EligibleAbility back to the BuffSource the translator expects. */
function bufferSourceFromEligible(entry: EligibleAbility): BuffSource {
  const abilityId = entry.ability.id;
  switch (entry.source.kind) {
    case "army":
      return { kind: "ability", abilityId, abilityKind: "army" };
    case "detachment":
      return { kind: "ability", abilityId, abilityKind: "detachment" };
    case "detachment-stratagem":
      return { kind: "ability", abilityId, abilityKind: "detachment-stratagem" };
    case "unit":
      return { kind: "ability", abilityId, abilityKind: "unit" };
    case "attached":
      return {
        kind: "ability",
        abilityId,
        abilityKind: "attached",
        sourceUnitId: entry.source.unitId,
      };
    case "support":
      return { kind: "ability", abilityId, abilityKind: "support" };
  }
}
