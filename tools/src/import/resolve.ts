/**
 * Resolve a {@link ParsedRoster} onto 40kdc entity ids, producing a {@link Roster}.
 *
 * Resolution is lenient: a name that doesn't match a 40kdc entity yields a
 * {@link ResolvedRef} with `id: null`, `resolved: false`, and up to five
 * candidate suggestions — the roster is never dropped or rejected. Everything
 * that didn't resolve cleanly is summarised in the {@link Diagnostics} block.
 *
 * Matching reuses the dataset's own lookups ({@link Collection.find},
 * {@link Collection.findAll}, {@link Collection.byFaction}) and
 * {@link normalizeName}; there is no bespoke fuzzy matcher. Faction is resolved
 * first so unit/detachment/enhancement lookups can be scoped to it — the same
 * unit id can appear under several factions, so scoping disambiguates.
 *
 * @packageDocumentation
 */
import type { Dataset } from "../data/dataset.js";
import type { UnitView } from "../data/entities.js";
import { detachmentCapForBattleSize } from "../data/battle-sizes.js";
import { groupLoadout } from "../data/loadout.js";
import { normalizeName, stripLeadingThe } from "../data/normalize.js";
import type {
  BattleSize,
  Candidate,
  Diagnostics,
  ParsedRoster,
  ParsedUnit,
  ResolvedRef,
  Roster,
  RosterDetachment,
  RosterFormat,
  RosterLoadoutGroup,
  RosterUnit,
  Warning,
  WarningCode,
} from "./types.js";

/** The dataset edition/dataslate stamped onto an imported roster. */
const ROSTER_GAME_VERSION = { edition: "11th", dataslate: "pre-launch-provisional" };

const MAX_CANDIDATES = 5;

interface NamedRecord {
  id: string;
  name: string;
}

/** Accumulates warnings and resolved/unresolved tallies during an import. */
class DiagnosticsBuilder {
  resolved_units = 0;
  unresolved_units = 0;
  resolved_weapons = 0;
  unresolved_weapons = 0;
  readonly warnings: Warning[] = [];

  warn(code: WarningCode, message: string, raw_name: string | null = null): void {
    this.warnings.push({ code, message, raw_name });
  }

  build(): Diagnostics {
    return {
      resolved_units: this.resolved_units,
      unresolved_units: this.unresolved_units,
      resolved_weapons: this.resolved_weapons,
      unresolved_weapons: this.unresolved_weapons,
      warnings: this.warnings,
    };
  }
}

function unresolved(raw_name: string, candidates: Candidate[] = []): ResolvedRef {
  return { id: null, raw_name, resolved: false, candidates };
}

function resolved(id: string, raw_name: string): ResolvedRef {
  return { id, raw_name, resolved: true, candidates: [] };
}

function toCandidates(records: readonly NamedRecord[]): Candidate[] {
  return records.slice(0, MAX_CANDIDATES).map((r) => ({ id: r.id, name: r.name }));
}

/** Map a source battle-size label to the 40kdc enum, if recognisable. */
function mapBattleSize(raw: string | null): BattleSize | null {
  if (!raw) return null;
  const key = normalizeName(raw);
  if (key.includes("strike force")) return "strike-force";
  if (key.includes("incursion")) return "incursion";
  return null;
}

/** 11e detachment-point budget for a battle size; null when the size is unknown. */
const detachmentCap = detachmentCapForBattleSize;

export function resolve(
  parsed: ParsedRoster,
  ds: Dataset,
  format: RosterFormat = "listforge",
): Roster {
  const diag = new DiagnosticsBuilder();

  if (parsed.multi_force) {
    diag.warn(
      "multi-force",
      "Source list contains more than one faction; the primary faction was used for scoping.",
    );
  }

  // --- Faction (resolved first so other lookups can scope to it). -----------
  let faction_id: string | null = null;
  if (parsed.faction_raw_name) {
    const hit = ds.factions.find(parsed.faction_raw_name);
    if (hit) {
      faction_id = hit.id;
    } else {
      diag.warn("faction-unresolved", "Faction name did not match any 40kdc faction.", parsed.faction_raw_name);
    }
  }

  // --- Detachments (each scoped to faction, then global fallback). ----------
  // 11e lists may field several detachments under a detachment-point cap; the
  // list preserves source order. `dp_cost` is looked up from the resolved
  // detachment entity (no source format reports it).
  const detachments: RosterDetachment[] = parsed.detachment_raw_names.map((raw_name) => {
    const key = normalizeName(raw_name);
    const scoped = faction_id
      ? ds.detachments.byFaction(faction_id).find((d) => normalizeName(d.name ?? "") === key)
      : undefined;
    const hit = scoped ?? ds.detachments.find(raw_name);
    if (hit) {
      return { ref: resolved(hit.id, raw_name), dp_cost: hit.detachment_points ?? null };
    }
    diag.warn("detachment-unresolved", "Detachment name did not match any 40kdc detachment.", raw_name);
    return {
      ref: unresolved(raw_name, toCandidates(ds.detachments.findAll(raw_name) as NamedRecord[])),
      dp_cost: null,
    };
  });
  const detachmentIds = detachments.map((d) => d.ref.id).filter((id): id is string => id !== null);

  // --- Force Disposition. ---------------------------------------------------
  // roster-json carries an already-resolved id; ListForge text carries the raw
  // header name (e.g. "Priority Assets"), resolved here against the dataset.
  let force_disposition = parsed.force_disposition ?? null;
  if (!force_disposition && parsed.force_disposition_raw_name) {
    const hit = ds.forceDispositions.find(parsed.force_disposition_raw_name);
    if (hit) {
      force_disposition = hit.id;
    } else {
      diag.warn(
        "disposition-unresolved",
        "Force Disposition name did not match any 40kdc disposition.",
        parsed.force_disposition_raw_name,
      );
    }
  }

  // --- Battle size. ---------------------------------------------------------
  const battle_size = mapBattleSize(parsed.battle_size_raw);
  if (parsed.battle_size_raw && battle_size === null) {
    diag.warn("battle-size-unmapped", "Battle size label could not be mapped.", parsed.battle_size_raw);
  }
  const detachment_cap = detachmentCap(battle_size);

  // --- Detachment-point cap check (only when cap and every cost are known). --
  if (detachment_cap !== null && detachments.length > 0 && detachments.every((d) => d.dp_cost !== null)) {
    const spent = detachments.reduce((sum, d) => sum + (d.dp_cost ?? 0), 0);
    if (spent > detachment_cap) {
      diag.warn(
        "detachment-points-exceeded",
        `Detachments cost ${spent} detachment points but the ${battle_size} budget is ${detachment_cap}.`,
      );
    }
  }

  // --- Units (and their enhancements / wargear). ----------------------------
  const units = parsed.units.map((u) => resolveUnit(u, faction_id, detachmentIds, ds, diag));

  // --- Leader attachments (second pass: needs all resolved unit ids). -------
  applyLeaderAttachments(parsed.units, units, ds, faction_id, diag);

  // --- Points reconciliation (reported vs computed kept distinct). ----------
  if (parsed.total_reported !== null && parsed.total_reported !== parsed.total_computed) {
    diag.warn(
      "points-mismatch",
      `Source-reported total (${parsed.total_reported}) differs from the sum of cost lines (${parsed.total_computed}).`,
    );
  }

  return {
    name: parsed.name,
    source: { format, generated_by: parsed.generated_by },
    faction_id,
    detachments,
    battle_size,
    // roster-json carries a resolved id; ListForge text resolves its raw header
    // name above. Formats that encode no disposition leave this null and the
    // roster-legality checker flags it (advisory).
    force_disposition,
    points: {
      declared_limit: parsed.declared_limit,
      detachment_cap,
      total_reported: parsed.total_reported,
      total_computed: parsed.total_computed,
    },
    units,
    game_version: { ...ROSTER_GAME_VERSION },
    diagnostics: diag.build(),
  };
}

/**
 * The canonical prefix the dataset uses for shared Chaos chassis ("Chaos Rhino",
 * "Chaos Land Raider", …). GW/NewRecruit subfaction exports substitute the faction
 * name for it ("Death Guard Rhino"), so swapping it back is one of the candidate
 * lookups (see {@link unitLookupCandidates}).
 */
const CHAOS_CHASSIS_PREFIX = "Chaos ";

/**
 * Candidate lookup strings for a unit name, in priority order. GW/NewRecruit
 * exports prefix shared chassis with the faction's display name in two forms:
 * keeping "Chaos" ("Death Guard Chaos Spawn" → dataset "Chaos Spawn") or replacing
 * it ("Death Guard Rhino" → dataset "Chaos Rhino"). When `raw_name` starts with the
 * resolved faction's display name we therefore also try the prefix stripped, and
 * the prefix replaced with {@link CHAOS_CHASSIS_PREFIX}. The original `raw_name` is
 * always what gets recorded on the ref — only the lookup is adjusted. This is a
 * general rule over all 16 shared Chaos chassis × every faction, not per-unit data.
 */
function unitLookupCandidates(raw_name: string, faction_id: string | null, ds: Dataset): string[] {
  const candidates = [raw_name];
  const factionName = faction_id ? ds.factions.getAny(faction_id)?.name : undefined;
  if (factionName) {
    const prefix = `${factionName} `;
    if (raw_name.length > prefix.length && raw_name.toLowerCase().startsWith(prefix.toLowerCase())) {
      const rest = raw_name.slice(prefix.length).trimStart();
      if (rest) {
        candidates.push(rest);
        candidates.push(CHAOS_CHASSIS_PREFIX + rest);
      }
    }
  }
  // De-duplicate while preserving order (e.g. a name that already starts with "Chaos ").
  return [...new Set(candidates)];
}

/**
 * Resolve a weapon raw name to candidate weapon views, tolerating a leading
 * "The " mismatch in either direction between roster exports and data names
 * (NewRecruit "The Bloody Twins" ↔ data "Bloody Twins"; GW "Fire Axe" ↔ data
 * "The Fire Axe"). Tries the name as given, then the "The"-stripped form, then
 * the "The"-prefixed form, returning the first non-empty match set. Each form
 * routes through {@link Collection.findAll} (id → normalized-name → substring).
 */
function findWeaponCandidates(ds: Dataset, rawName: string) {
  const direct = ds.weapons.findAll(rawName);
  if (direct.length > 0) return direct;
  const stripped = stripLeadingThe(rawName);
  if (stripped) {
    const hits = ds.weapons.findAll(stripped);
    if (hits.length > 0) return hits;
  }
  return ds.weapons.findAll(`The ${rawName}`);
}

/**
 * Resolve a weapon raw name to one of the RESOLVED unit's own weapon ids — its
 * `weapon_ids` plus any ids reachable through its wargear options. Per-unit stat
 * variants share a NAME (e.g. `dragon-fusion-gun` vs `dragon-fusion-gun-fire-dragons`),
 * so a name match must pick the variant the resolved unit actually fields. Matches
 * by {@link normalizeName} with the same leading-"The" tolerance as
 * {@link findWeaponCandidates}. Returns null when the unit fields no weapon of that
 * name (the caller then falls back to the global lookup).
 */
function scopedWeaponId(ds: Dataset, hit: UnitView, rawName: string): string | null {
  const ids = new Set<string>(hit.raw.weapon_ids ?? []);
  for (const opt of ds.wargearOptionsOf(hit.raw)) {
    for (const id of opt.replaces ?? []) ids.add(id);
    for (const id of opt.replacement ?? []) ids.add(id);
    for (const group of opt.replacement_choice ?? []) for (const id of group) ids.add(id);
  }
  const stripped = stripLeadingThe(rawName);
  const targets = new Set<string>([normalizeName(rawName), normalizeName(`The ${rawName}`)]);
  if (stripped) targets.add(normalizeName(stripped));
  for (const id of ids) {
    const w = ds.weapons.getInFaction(id, hit.raw.faction_id) ?? ds.weapons.getAny(id);
    if (w && targets.has(normalizeName(w.name))) return id;
  }
  return null;
}

function resolveUnit(
  parsed: ParsedUnit,
  faction_id: string | null,
  detachmentIds: string[],
  ds: Dataset,
  diag: DiagnosticsBuilder,
): RosterUnit {
  const lookupNames = unitLookupCandidates(parsed.raw_name, faction_id, ds);

  // Prefer a faction-scoped exact match (the same unit id recurs across factions,
  // and a stripped base name can collide with another faction's unit — e.g.
  // "Rhino" matches the Space Marine Rhino), matching canonical name or alias.
  const inFaction = faction_id ? ds.units.byFaction(faction_id) : [];
  const scopedExact = (q: string) => {
    const k = normalizeName(q);
    return inFaction.find(
      (u) => normalizeName(u.name) === k || (u.raw.aliases ?? []).some((a) => normalizeName(a) === k),
    );
  };

  let hit = lookupNames.map(scopedExact).find(Boolean);
  let all: UnitView[] = [];
  if (!hit) {
    // Global fallback (alias-aware via the name index); still prefer the resolved
    // faction's copy of a shared id over whichever copy registered first.
    for (const q of lookupNames) {
      all = ds.units.findAll(q);
      hit = (faction_id ? all.find((u) => u.raw.faction_id === faction_id) : undefined) ?? all[0];
      if (hit) break;
    }
  }

  let ref: ResolvedRef;
  if (hit) {
    ref = resolved(hit.id, parsed.raw_name);
    diag.resolved_units += 1;
  } else {
    ref = unresolved(parsed.raw_name, toCandidates(all));
    diag.unresolved_units += 1;
    diag.warn("unit-unresolved", "Unit name did not match any 40kdc unit.", parsed.raw_name);
  }

  const enhancement = parsed.enhancement_raw_name
    ? resolveEnhancement(parsed.enhancement_raw_name, detachmentIds, ds, diag)
    : null;
  const enhancement_points = enhancement === null ? null : parsed.enhancement_points;

  const wargear = parsed.wargear.map((w) => {
    // Prefer the resolved unit's own weapon of this name — picks the right
    // per-unit stat variant — falling back to the global lookup only when the
    // unit is unresolved or fields no weapon of that name.
    const scopedId = hit ? scopedWeaponId(ds, hit, w.raw_name) : null;
    if (scopedId) {
      diag.resolved_weapons += 1;
      return { ref: resolved(scopedId, w.raw_name), count: w.count };
    }
    const hits = findWeaponCandidates(ds, w.raw_name);
    if (hits[0]) {
      diag.resolved_weapons += 1;
      return { ref: resolved(hits[0].id, w.raw_name), count: w.count };
    }
    diag.unresolved_weapons += 1;
    diag.warn("weapon-unresolved", "Weapon name did not match any 40kdc weapon.", w.raw_name);
    return { ref: unresolved(w.raw_name, toCandidates(hits)), count: w.count };
  });

  // Reconstruct the per-model-type loadout groups deterministically from the
  // resolved unit, so a re-export reproduces the same grouped lines the exporter
  // emits (round-trip), without the text parsers having to understand model-name
  // labels. Only when the unit and every weapon resolved and the loadout
  // decomposes exactly (groupLoadout returns null otherwise).
  const loadout_groups = buildLoadoutGroups(hit, parsed.model_count, wargear, ds);

  return {
    ref,
    model_count: parsed.model_count,
    points: parsed.points,
    is_warlord: parsed.is_warlord,
    enhancement,
    enhancement_points,
    wargear,
    ...(loadout_groups ? { loadout_groups } : {}),
    leader_attachment: null,
  };
}

/**
 * Recompute a unit's {@link RosterUnit.loadout_groups} from its resolved wargear via
 * {@link groupLoadout} — the same maths the exporter uses, so an import→export
 * round-trip is stable. Returns `undefined` when the unit is unresolved, any weapon
 * is unresolved (the aggregate would be incomplete), or the loadout doesn't
 * decompose exactly.
 */
function buildLoadoutGroups(
  hit: UnitView | undefined,
  modelCount: number,
  wargear: { ref: ResolvedRef; count: number }[],
  ds: Dataset,
): RosterLoadoutGroup[] | undefined {
  if (!hit) return undefined;
  const refById = new Map<string, ResolvedRef>();
  const counts = new Map<string, number>();
  for (const w of wargear) {
    if (!w.ref.id) return undefined; // incomplete aggregate → can't group faithfully
    refById.set(w.ref.id, w.ref);
    counts.set(w.ref.id, (counts.get(w.ref.id) ?? 0) + w.count);
  }
  const groups = groupLoadout(
    hit.raw,
    modelCount,
    ds.wargearOptionsOf(hit.raw),
    ds.unitCompositionOf(hit.raw)?.models,
    counts,
  );
  if (!groups) return undefined;
  return groups.map((g) => ({
    model_name: g.model_name,
    count: g.count,
    wargear: g.weapons.map((w) => ({ ref: refById.get(w.id)!, count: w.count })),
  }));
}

function resolveEnhancement(
  raw_name: string,
  detachmentIds: string[],
  ds: Dataset,
  diag: DiagnosticsBuilder,
): ResolvedRef {
  const key = normalizeName(raw_name);
  // Enhancements belong to a detachment, not a faction — scope to any of the
  // roster's resolved detachments.
  const scoped =
    detachmentIds.length > 0
      ? ds.enhancements.all.find(
          (e) =>
            e.detachment_id != null &&
            detachmentIds.includes(e.detachment_id) &&
            normalizeName(e.name ?? "") === key,
        )
      : undefined;
  const hit = scoped ?? ds.enhancements.find(raw_name);
  if (hit) {
    return resolved(hit.id, raw_name);
  }
  diag.warn("enhancement-unresolved", "Enhancement name did not match any 40kdc enhancement.", raw_name);
  return unresolved(raw_name, toCandidates(ds.enhancements.findAll(raw_name) as NamedRecord[]));
}

/**
 * Resolve leader→bodyguard attachments in two passes.
 *
 * 1. **Explicit** attachments carried verbatim from the source (only the
 *    canonical roster-json round-trip encodes one) are reconstructed exactly —
 *    the bodyguard id is re-resolved against the current dataset, but the role
 *    and provisional flag are preserved. This makes the round-trip lossless,
 *    including `leader`-role attachments that inference never produces.
 * 2. For every other character, the source does not encode an unambiguous
 *    attachment, so each **inferred** link is marked provisional: a resolved
 *    `support` character (which cannot operate alone) is matched against a
 *    resolved bodyguard present in the roster using the dataset's
 *    leader-attachment data.
 */
function applyLeaderAttachments(
  parsedUnits: ParsedUnit[],
  units: RosterUnit[],
  ds: Dataset,
  factionId: string | null,
  diag: DiagnosticsBuilder,
): void {
  // --- Pass 1: explicit attachments (lossless). ----------------------------
  units.forEach((unit, i) => {
    const explicit = parsedUnits[i].leader_attachment;
    if (explicit == null) return;
    const key = normalizeName(explicit.bodyguard_raw_name);
    const bodyguard = units.find((u) => normalizeName(u.ref.raw_name) === key);
    if (!bodyguard) return;
    unit.leader_attachment = {
      bodyguard_ref:
        bodyguard.ref.id != null
          ? resolved(bodyguard.ref.id, bodyguard.ref.raw_name)
          : unresolved(bodyguard.ref.raw_name),
      role: explicit.role,
      provisional: explicit.provisional,
    };
  });

  // --- Pass 2: inference for characters without an explicit attachment. -----
  const bodyguardIds = new Set(
    units.filter((u, i) => u.ref.id && !parsedUnits[i].is_character).map((u) => u.ref.id as string),
  );

  units.forEach((unit, i) => {
    if (parsedUnits[i].leader_attachment != null) return; // explicit already applied
    if (!unit.ref.id || !parsedUnits[i].is_character) return;
    const leaderId = unit.ref.id;
    // Only `support` characters are auto-attached: per the GW datasheet
    // bodyguard-group data they cannot operate alone, so attaching to an
    // eligible bodyguard present in the roster is certain. A `leader` (or a
    // character with no attachment_role) MAY be solo — the source doesn't
    // encode the attachment, so we don't guess one. attachment_role is
    // faction-specific (e.g. the World Eaters Master of Executions is a leader
    // while the Chaos Space Marines one is support), so resolve faction-scoped.
    const resolvedUnit = factionId
      ? (ds.units.getInFaction(leaderId, factionId) ?? ds.units.getAny(leaderId))
      : ds.units.getAny(leaderId);
    if (resolvedUnit?.raw.attachment_role !== "support") return;

    const attachment = ds.leaderAttachments.find((la) => la.leader_id === leaderId);
    if (!attachment) return;
    const bodyguardId = attachment.eligible_bodyguard_ids.find((id) => bodyguardIds.has(id));
    if (!bodyguardId) return;

    const bodyguard = units.find((u) => u.ref.id === bodyguardId);
    if (!bodyguard) return;

    unit.leader_attachment = {
      bodyguard_ref: resolved(bodyguardId, bodyguard.ref.raw_name),
      role: "support",
      provisional: true,
    };
    diag.warn(
      "leader-attachment-inferred",
      "Support character attached to an eligible bodyguard (it cannot operate alone); provisional.",
      unit.ref.raw_name,
    );
  });
}
