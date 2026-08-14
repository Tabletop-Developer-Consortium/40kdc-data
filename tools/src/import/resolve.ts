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
import { checkUnitLegality, completeLoadout, groupLoadout } from "../data/loadout.js";
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
  RosterWargear,
  Warning,
  WarningCode,
} from "./types.js";

/** The dataset edition/dataslate stamped onto an imported roster. */
const ROSTER_GAME_VERSION = { edition: "11th", dataslate: "pre-launch-provisional" };

const MAX_CANDIDATES = 5;
const FACTION_NAME_ALIASES: Readonly<Record<string, string>> = {
  "imperial guard": "Astra Militarum",
  "league of votann": "Leagues of Votann",
};
const DETACHMENT_SOURCE_ALIASES: Readonly<Record<string, string>> = {
  "hearthband covenant": "Hearthguard Covenant",
  "lord of the forge": "Lords of the Forge",
  radzone: "Rad-Zone Corps",
};
const SOURCE_NAME_ALIASES: Readonly<Record<string, string>> = {
  "exo armour grenade launcher": "Exoarmour grenade launcher",
  "kombi rokkit": "Kombi-weapon",
  "kombi shoota": "Kombi-weapon",
  "leaders bio weapons": "Leader’s cult weapons",
  "pan spectral scanner": "Panspectral Scanner",
  "squig bomb": "Bomb Squig",
};

function factionNameCandidates(rawName: string): string[] {
  const candidates = [rawName.trim()];
  const aka = /\baka\b\s+(.+)$/i.exec(rawName);
  if (aka) candidates.unshift(aka[1].trim());
  const firstFaction = rawName.split(/\s+and\s+/i)[0]?.trim();
  if (firstFaction && firstFaction !== rawName.trim()) candidates.push(firstFaction);
  const alias = FACTION_NAME_ALIASES[normalizeName(rawName)];
  if (alias) candidates.unshift(alias);
  return [...new Set(candidates.filter(Boolean))];
}
function normalizeDetachmentSourceName(rawName: string): string {
  const normalized = rawName
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(
      /\s*\(\s*\d*\s*(?:detachment points?|detachementpoints?|dp|pd)\s*\)/gi,
      "",
    )
    .trim();
  return DETACHMENT_SOURCE_ALIASES[normalizeName(normalized)] ?? normalized;
}

function normalizedSourcePunctuation(rawName: string): string {
  return rawName
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\bautocanon\b/gi, "autocannon");
}

function sourceNameAlias(rawName: string): string | null {
  return SOURCE_NAME_ALIASES[normalizeName(normalizedSourcePunctuation(rawName))] ?? null;
}

function sourceNameVariants(rawName: string): string[] {
  const normalizedPunctuation = normalizedSourcePunctuation(rawName);
  const alias = sourceNameAlias(rawName);
  return [...new Set([rawName, normalizedPunctuation, ...(alias ? [alias] : [])])];
}

function lookupNameKeys(rawName: string): Set<string> {
  const keys = new Set<string>();
  for (const variant of sourceNameVariants(rawName)) {
    keys.add(normalizeName(variant));
    keys.add(normalizeName(`The ${variant}`));
    const stripped = stripLeadingThe(variant);
    if (stripped) keys.add(normalizeName(stripped));
  }
  return keys;
}

function singularNameKey(rawName: string): string {
  return normalizeName(rawName).replace(/s\b/g, "");
}

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
  if (key.includes("strike force") || key.includes("strikeforce")) return "strike-force";
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


  // --- Faction (resolved first so other lookups can scope to it). -----------
  let faction_id: string | null = null;
  const detachmentRawNames = [...parsed.detachment_raw_names];
  let factionWasInferred = false;
  if (parsed.faction_raw_name) {
    let directHit = factionNameCandidates(parsed.faction_raw_name)
      .map((candidate) => ds.factions.find(candidate))
      .find((candidate) => candidate !== undefined);

    // Event comments may sit between the title and the real metadata. The text
    // parser preserves those logical lines as detachment candidates; recover
    // an exact faction line before trying positional fallbacks.
    if (!directHit) {
      let factionLineIndex = -1;
      for (let index = detachmentRawNames.length - 1; index >= 0; index -= 1) {
        if (
          factionNameCandidates(detachmentRawNames[index]).some((candidate) =>
            ds.factions.find(candidate),
          )
        ) {
          factionLineIndex = index;
          break;
        }
      }
      if (factionLineIndex >= 0) {
        directHit = factionNameCandidates(detachmentRawNames[factionLineIndex])
          .map((candidate) => ds.factions.find(candidate))
          .find((candidate) => candidate !== undefined);
        detachmentRawNames.splice(0, factionLineIndex + 1);
      }
    }

    if (directHit) {
      faction_id = directHit.id;
    } else {
      // Some copy/paste pipelines remove every metadata line break, leaving
      // `<Faction> <Detachment(s)>` as one token. Recover only an exact faction
      // prefix; the remaining words still go through ordinary detachment
      // resolution below.
      const rawKey = normalizeName(parsed.faction_raw_name);
      const prefixHit = ds.factions.all
        .filter((faction) => rawKey.startsWith(`${normalizeName(faction.name)} `))
        .sort((a, b) => normalizeName(b.name).length - normalizeName(a.name).length)[0];
      if (prefixHit) {
        faction_id = prefixHit.id;
        const factionWordCount = prefixHit.name.trim().split(/\s+/).length;
        const remainder = parsed.faction_raw_name
          .trim()
          .split(/\s+/)
          .slice(factionWordCount)
          .join(" ")
          .replace(/\s*\(\d+\s+Detachment Points?\)\s*$/i, "");
        const secondaryFaction = /^and\s+(.+)$/i.exec(remainder);
        const secondaryHit =
          secondaryFaction &&
          factionNameCandidates(secondaryFaction[1])
            .map((candidate) => ds.factions.find(candidate))
            .find((candidate) => candidate !== undefined);
        if (remainder && !secondaryHit) detachmentRawNames.push(remainder);
      } else {
        // Title-less exports put the faction on line one, where the text
        // grammar initially treats it as the roster name. The misclassified
        // preamble token is then the detachment.
        const titleHit = factionNameCandidates(parsed.name)
          .map((candidate) => ds.factions.find(candidate))
          .find((candidate) => candidate !== undefined);
        if (titleHit) {
          faction_id = titleHit.id;
          const recoveredDetachment = parsed.faction_raw_name.replace(
            /\s*\(\d+\s+(?:Detachment Points?|PD)\)\s*$/i,
            "",
          );
          if (recoveredDetachment) detachmentRawNames.unshift(recoveredDetachment);
        }
      }
    }
  }

  if (faction_id === null) {
    // A few accepted event lists omit army metadata altogether. Infer only
    // from exact, faction-unique unit names; ties remain unresolved.
    const counts = new Map<string, number>();
    for (const unit of parsed.units) {
      const exactFactions = new Set(
        unitLookupCandidates(unit.raw_name, null, ds)
          .flatMap((candidate) => ds.units.findAll(candidate))
          .filter((candidate) => {
            const key = normalizeName(unit.raw_name);
            return (
              normalizeName(candidate.name) === key ||
              (candidate.raw.aliases ?? []).some((alias) => normalizeName(alias) === key)
            );
          })
          .map((candidate) => candidate.raw.faction_id),
      );
      if (exactFactions.size === 1) {
        const inferred = [...exactFactions][0];
        counts.set(inferred, (counts.get(inferred) ?? 0) + 1);
      }
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    if (ranked[0] && (!ranked[1] || ranked[0][1] > ranked[1][1])) {
      faction_id = ranked[0][0];
      factionWasInferred = true;
    }
  }

  if (faction_id === null && parsed.faction_raw_name) {
    diag.warn(
      "faction-unresolved",
      "Faction name did not match any 40kdc faction.",
      parsed.faction_raw_name,
    );
  }

  // --- Detachments (each scoped to faction, then global fallback). ----------
  // 11e lists may field several detachments under a detachment-point cap; the
  // list preserves source order. `dp_cost` is looked up from the resolved
  // detachment entity (no source format reports it).
  const resolveDetachment = (raw_name: string): RosterDetachment | null => {
    const lookupName = normalizeDetachmentSourceName(raw_name);
    const key = normalizeName(lookupName);
    const scoped = faction_id
      ? ds.detachments.byFaction(faction_id).find((d) => normalizeName(d.name ?? "") === key)
      : undefined;
    const hit = scoped ?? ds.detachments.find(lookupName);
    if (!hit) return null;
    return { ref: resolved(hit.id, raw_name), dp_cost: hit.detachment_points ?? null };
  };
  const coalescedDetachmentNames: string[] = [];
  for (const rawName of detachmentRawNames) {
    const previous = coalescedDetachmentNames.at(-1);
    if (previous?.trimEnd().endsWith(" and")) {
      coalescedDetachmentNames[coalescedDetachmentNames.length - 1] =
        `${previous} ${rawName}`;
    } else if (rawName.trim()) {
      coalescedDetachmentNames.push(rawName);
    }
  }
  const detachments: RosterDetachment[] = coalescedDetachmentNames.flatMap((raw_name) => {
    const whole = resolveDetachment(raw_name);
    if (whole) return [whole];
    // Dual-detachment 11e lists print both names on one line joined with
    // " and " ("Hexwarp Thrallband and Sekhetar Cohort") or a comma
    // ("Exhibition of Slaughter, Skysplinter Assault"). Splitting is a
    // RESOLVE-TIME fallback, taken only when the whole name fails and every
    // part resolves — "Legends of Saga and Song" is a real single-detachment
    // name a lexical split would corrupt.
    const parts = raw_name
      .split(/\s+(?:and|\+)\s+|\s*,\s*/i)
      .map((part) => normalizeDetachmentSourceName(part.replace(/^and\s+/i, "")));
    if (parts.length > 1) {
      const split = parts.map((part) => resolveDetachment(part));
      if (split.every((d): d is RosterDetachment => d !== null)) return split;
    }
    if (factionWasInferred) return [];
    diag.warn("detachment-unresolved", "Detachment name did not match any 40kdc detachment.", raw_name);
    return [
      {
        ref: unresolved(raw_name, toCandidates(ds.detachments.findAll(raw_name) as NamedRecord[])),
        dp_cost: null,
      },
    ];
  });
  const detachmentIds = detachments.map((d) => d.ref.id).filter((id): id is string => id !== null);

  // --- Force Disposition. ---------------------------------------------------
  // roster-json carries an already-resolved id; ListForge and WTC text carry
  // the raw header name (e.g. "Priority Assets"), resolved here against the
  // dataset.
  let force_disposition = parsed.force_disposition ?? null;
  if (!force_disposition && parsed.force_disposition_raw_name) {
    const dispositionName =
      normalizeName(parsed.force_disposition_raw_name) === "recon"
        ? "Reconnaissance"
        : parsed.force_disposition_raw_name;
    const hit = ds.forceDispositions.find(dispositionName);
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
  // A metadata-less source can still identify its detachment unambiguously through
  // enhancement ownership. Resolve those units globally first, then recover the
  // one shared detachment and its sole legal Force Disposition.
  const enhancementById = (id: string) =>
    faction_id ? ds.enhancements.getInFaction(id, faction_id) : ds.enhancements.getAny(id);
  const detachmentById = (id: string) =>
    faction_id ? ds.detachments.getInFaction(id, faction_id) : ds.detachments.getAny(id);

  if (detachments.length === 0) {
    const inferredDetachmentIds = new Set(
      units.flatMap((unit) => {
        const enhancementId = unit.enhancement?.id;
        const detachmentId = enhancementId
          ? enhancementById(enhancementId)?.detachment_id
          : undefined;
        return detachmentId ? [detachmentId] : [];
      }),
    );
    if (inferredDetachmentIds.size === 1) {
      const detachmentId = [...inferredDetachmentIds][0];
      const detachment = detachmentById(detachmentId);
      if (detachment) {
        detachments.push({
          ref: resolved(detachment.id, detachment.name),
          dp_cost: detachment.detachment_points ?? null,
        });
        detachmentIds.push(detachment.id);
      }
    }
  }
  if (
    force_disposition === null &&
    parsed.force_disposition_raw_name === null &&
    detachmentIds.length > 0
  ) {
    const dispositionIds = new Set(
      detachmentIds.flatMap((id) => detachmentById(id)?.force_dispositions ?? []),
    );
    const everyDetachmentHasOnlyThatDisposition = detachmentIds.every(
      (id) => detachmentById(id)?.force_dispositions?.length === 1,
    );
    if (everyDetachmentHasOnlyThatDisposition && dispositionIds.size === 1) {
      force_disposition = [...dispositionIds][0];
    }
  }

  // Some GW text exports omit the Warlord annotation while retaining explicit
  // Character classification. A valid roster still has exactly one Warlord, so
  // preserve source order and use the first explicitly classified Character.
  if (format === "gw" && !units.some((unit) => unit.is_warlord)) {
    const firstCharacter = parsed.units.findIndex((unit) => unit.is_character);
    if (firstCharacter >= 0) units[firstCharacter].is_warlord = true;
  }

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
  const delimitedName = raw_name.split(/\s+--?\s+/).at(-1)?.trim();
  if (delimitedName && delimitedName !== raw_name) candidates.push(delimitedName);
  const withoutNickname = raw_name.replace(
    /\s+(?:["“][^"”]+["”]|'[^']+')\s*$/,
    "",
  );
  if (withoutNickname !== raw_name) candidates.push(withoutNickname);
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
  for (const variant of sourceNameVariants(rawName)) {
    const direct = ds.weapons.findAll(variant);
    if (direct.length > 0) return direct;
    const stripped = stripLeadingThe(variant);
    if (stripped) {
      const hits = ds.weapons.findAll(stripped);
      if (hits.length > 0) return hits;
    }
    const prefixed = ds.weapons.findAll(`The ${variant}`);
    if (prefixed.length > 0) return prefixed;
  }
  return [];
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
  const directTargets = new Set(
    [rawName, normalizedSourcePunctuation(rawName)].map(normalizeName),
  );
  for (const id of ids) {
    const weapon =
      ds.weapons.getInFaction(id, hit.raw.faction_id) ?? ds.weapons.getAny(id);
    if (
      weapon &&
      [weapon.name, normalizedSourcePunctuation(weapon.name)].some((name) =>
        directTargets.has(normalizeName(name)),
      )
    ) {
      return id;
    }
  }
  const targets = lookupNameKeys(rawName);
  const singularTargets = new Set(sourceNameVariants(rawName).map(singularNameKey));
  const singularMatches: string[] = [];
  for (const id of ids) {
    const w = ds.weapons.getInFaction(id, hit.raw.faction_id) ?? ds.weapons.getAny(id);
    if (!w) continue;
    if (sourceNameVariants(w.name).some((variant) => targets.has(normalizeName(variant)))) {
      return id;
    }
    if (
      sourceNameVariants(w.name).some((variant) =>
        singularTargets.has(singularNameKey(variant)),
      )
    ) {
      singularMatches.push(id);
    }
  }
  return singularMatches.length === 1 ? singularMatches[0] : null;
}

/**
 * Fallback for wargear ITEMS (Simulacrum Imperialis, Daemonic Icon, …) — raw
 * names that are not weapons but do exist in the wargear collection. Runs only
 * after BOTH weapon lookups miss, so a wargear item whose name collides with a
 * weapon ("multi-melta", "power weapon") keeps resolving to the weapon exactly
 * as before. Scoped-first: ids reachable through the resolved unit's wargear
 * options, then the global collection (wargear is replicated-identical across
 * factions, so a global first-match is safe). Same {@link normalizeName} +
 * leading-"The" tolerance as the weapon lookups.
 */
function resolveWargearItemId(ds: Dataset, hit: UnitView | null, rawName: string): string | null {
  const targets = lookupNameKeys(rawName);
  const singularTargets = new Set(sourceNameVariants(rawName).map(singularNameKey));
  if (hit) {
    const ids = new Set<string>();
    for (const opt of ds.wargearOptionsOf(hit.raw)) {
      for (const id of opt.replaces ?? []) ids.add(id);
      for (const id of opt.replacement ?? []) ids.add(id);
      for (const group of opt.replacement_choice ?? []) for (const id of group) ids.add(id);
    }
    const singularMatches: string[] = [];
    for (const id of ids) {
      const item = ds.wargear.getAny(id);
      if (!item) continue;
      if (
        sourceNameVariants(item.name).some((variant) => targets.has(normalizeName(variant)))
      ) {
        return id;
      }
      if (
        sourceNameVariants(item.name).some((variant) =>
          singularTargets.has(singularNameKey(variant)),
        )
      ) {
        singularMatches.push(id);
      }
    }
    if (singularMatches.length === 1) return singularMatches[0];
  }
  for (const variant of sourceNameVariants(rawName)) {
    const direct = ds.wargear.find(variant);
    if (direct) return direct.id;
    const stripped = stripLeadingThe(variant);
    if (stripped) {
      const strippedHit = ds.wargear.find(stripped);
      if (strippedHit) return strippedHit.id;
    }
    const prefixed = ds.wargear.find(`The ${variant}`);
    if (prefixed) return prefixed.id;
  }
  return null;
}

/** Resolve a bare unit ability emitted among its equipment lines. */
function resolveUnitAbilityId(ds: Dataset, hit: UnitView | null, rawName: string): string | null {
  if (!hit) return null;
  const targets = lookupNameKeys(rawName);
  for (const id of hit.raw.ability_ids ?? []) {
    const ability =
      ds.abilities.getInFaction(id, hit.raw.faction_id) ?? ds.abilities.getAny(id);
    if (
      ability &&
      sourceNameVariants(ability.name).some((variant) => targets.has(normalizeName(variant)))
    ) {
      return id;
    }
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

  // ── Model-line reclassification ────────────────────────────────────────
  // The flat GW dialects print model bullets at the same indent as weapon
  // bullets, so the parser cannot tell "• 9x Pathfinder" from "• 10x Pulse
  // carbine" — the model names land in `wargear` and `model_count` collapses
  // to its 1 fallback (which failed every tier check and inflated per-model
  // ceilings across the ATC corpus). The RESOLVED unit knows its composition
  // row names — and its own name covers vehicle squadrons ("2x Hippogriff
  // AFV") — so a wargear entry matching one (singular/plural-insensitive) is a
  // model line: its count rebuilds the model count and it leaves the wargear
  // bag. If the parser already produced a valid composition-tier count, matching
  // lines are duplicate model labels separated from their children by source
  // annotations; remove them without counting them again.
  let model_count = parsed.model_count;
  let wargearLines = parsed.wargear;
  if (hit) {
    const unitModelNames = new Set<string>([singularNameKey(hit.name)]);
    for (const alias of hit.raw.aliases ?? []) {
      unitModelNames.add(singularNameKey(alias));
    }
    const compositionModelNames = new Set<string>();
    for (const m of ds.unitCompositionOf(hit.raw)?.models ?? []) {
      if (m.name) compositionModelNames.add(singularNameKey(m.name));
      if (m.profile_name) compositionModelNames.add(singularNameKey(m.profile_name));
    }
    const modelLineKeys = (raw: string): Set<string> => {
      const variants = [raw, ...raw.split(/\s+--?\s+/)];
      const withBase = raw.split(/\s+with\s+/i)[0]?.trim();
      if (withBase) variants.push(withBase);
      const withoutRole = raw.replace(/\s+character$/i, "");
      if (withoutRole !== raw) variants.push(withoutRole);
      const withoutNickname = raw.replace(
        /\s+(?:["“][^"”]+["”]?|'[^']+'?)\s*$/,
        "",
      );
      if (withoutNickname !== raw) variants.push(withoutNickname);
      return new Set(variants.flatMap(sourceNameVariants).map(singularNameKey));
    };
    const matchesModelName = (raw: string, modelName: string): boolean => {
      const keys = modelLineKeys(raw);
      return [...keys].some(
        (key) =>
          key === modelName ||
          (!modelName.includes(" with ") && modelName.endsWith(` ${key}`)),
      );
    };
    const isModelLine = (raw: string): boolean => {
      const keys = modelLineKeys(raw);
      if (
        [...unitModelNames, ...compositionModelNames].some((modelName) =>
          keys.has(modelName),
        )
      ) {
        return true;
      }
      return [...compositionModelNames].filter((modelName) =>
        matchesModelName(raw, modelName),
      ).length === 1;
    };
    const modelLines = parsed.wargear.filter((w) => isModelLine(w.raw_name));
    const modelSum = modelLines.reduce((s, w) => s + w.count, 0);
    if (modelSum > 0) {
      wargearLines = parsed.wargear.filter((w) => !isModelLine(w.raw_name));
      const composition = ds.unitCompositionOf(hit.raw);
      const rows = composition?.models ?? [];
      const parsedCountValid =
        (composition?.tiers ?? []).some((tier) => {
          const tierRows = tier.models ?? [];
          const min = tierRows.reduce((sum, model) => sum + (model.min ?? 0), 0);
          const max = tierRows.reduce((sum, model) => sum + (model.max ?? 0), 0);
          return parsed.model_count >= min && parsed.model_count <= max;
        }) ||
        ((composition?.tiers?.length ?? 0) === 0 &&
          rows.length > 0 &&
          parsed.model_count >= rows.reduce((sum, model) => sum + (model.min ?? 0), 0) &&
          parsed.model_count <= rows.reduce((sum, model) => sum + (model.max ?? 0), 0));
      const modelSumMatchesPoints =
        parsed.points !== null &&
        (hit.raw.points ?? []).some(
          (tier) =>
            tier.cost === parsed.points &&
            tier.models <= modelSum &&
            modelSum <= (tier.models_max ?? tier.models),
        );
      const covered =
        rows.length === 0 ||
        rows.every(
          (model) =>
            (model.min ?? 0) <= 0 ||
            (!model.name && !model.profile_name) ||
            modelLines.some(
              (line) =>
                (model.name &&
                  matchesModelName(line.raw_name, singularNameKey(model.name))) ||
                (model.profile_name &&
                  matchesModelName(line.raw_name, singularNameKey(model.profile_name))),
            ),
        );
      model_count =
        modelSumMatchesPoints || covered
          ? modelSum
          : parsedCountValid
            ? parsed.model_count
            : parsed.model_count + modelSum;
    }
  }

  const resolveGearRef = (rawName: string): ResolvedRef | null => {
    // Prefer the resolved unit's own weapon of this name — picks the right
    // per-unit stat variant — falling back to the global lookup only when the
    // unit is unresolved or fields no weapon of that name.
    const scopedId = hit ? scopedWeaponId(ds, hit, rawName) : null;
    if (scopedId) return resolved(scopedId, rawName);
    const hits = findWeaponCandidates(ds, rawName);
    if (hits[0]) return resolved(hits[0].id, rawName);
    const wargearItemId = resolveWargearItemId(ds, hit ?? null, rawName);
    if (wargearItemId) return resolved(wargearItemId, rawName);
    const abilityId = resolveUnitAbilityId(ds, hit ?? null, rawName);
    return abilityId ? resolved(abilityId, rawName) : null;
  };

  let wargear = wargearLines.flatMap((w) => {

    const direct = resolveGearRef(w.raw_name);
    if (direct) {
      diag.resolved_weapons += 1;
      return [{ ref: direct, count: w.count }];
    }

    // Some list generators join a model's separate weapons with prose `and`
    // rather than commas. Split only as a resolve-time fallback and only when
    // every part resolves, preserving genuine weapon names containing "and".
    const parts = w.raw_name.split(/\s+and\s+/i).map((part) => part.trim());
    if (parts.length > 1) {
      const partRefs = parts.map(resolveGearRef);
      if (partRefs.every((part): part is ResolvedRef => part !== null)) {
        diag.resolved_weapons += partRefs.length;
        return partRefs.map((part, index) => ({
          ref: part,
          count: index === 0 ? w.count : 1,
        }));
      }
    }

    const hits = findWeaponCandidates(ds, w.raw_name);
    diag.unresolved_weapons += 1;
    diag.warn("weapon-unresolved", "Weapon name did not match any 40kdc weapon.", w.raw_name);
    return [{ ref: unresolved(w.raw_name, toCandidates(hits)), count: w.count }];
  });

  // Preserve exact groups carried by a source format. Otherwise reconstruct
  // them from the aggregate, completing only omitted implicit defaults.
  const explicitGroupRefs = (rawName: string, count: number): RosterWargear[] => {
    const direct = wargear.find(
      (item) => normalizeName(item.ref.raw_name) === normalizeName(rawName),
    );
    if (direct) return [{ ref: direct.ref, count }];
    const ref = resolveGearRef(rawName);
    if (ref) return [{ ref, count }];
    const parts = rawName.split(/\s+and\s+/i).map((part) => part.trim());
    if (parts.length > 1) {
      const refs = parts.map(resolveGearRef);
      if (refs.every((part): part is ResolvedRef => part !== null)) {
        return refs.map((part) => ({ ref: part, count }));
      }
    }
    return [{ ref: unresolved(rawName, []), count }];
  };
  let loadout_groups =
    parsed.loadout_groups?.map((group) => ({
      model_name: group.model_name,
      count: group.count,
      wargear: group.wargear.flatMap((item) =>
        explicitGroupRefs(item.raw_name, item.count),
      ),
    })) ?? buildLoadoutGroups(hit, model_count, wargear, ds);
  if (
    parsed.loadout_groups &&
    loadout_groups &&
    loadout_groups.every((group) => group.wargear.every((item) => item.ref.id !== null))
  ) {
    const originalIds = new Set(wargear.map((item) => item.ref.id!));
    const grouped = new Map<string, RosterWargear>();
    for (const group of loadout_groups) {
      for (const item of group.wargear) {
        const id = item.ref.id!;
        const existing = grouped.get(id);
        const count = group.count * item.count;
        grouped.set(
          id,
          existing
            ? { ...existing, count: existing.count + count }
            : { ref: item.ref, count },
        );
      }
    }
    for (const item of wargear) {
      if (!grouped.has(item.ref.id!)) grouped.set(item.ref.id!, item);
    }
    diag.resolved_weapons += [...grouped.keys()].filter((id) => !originalIds.has(id)).length;
    wargear = [...grouped.values()];
  }
  if (!loadout_groups && hit && wargear.every((item) => item.ref.id !== null)) {
    const explicitRefs = new Map(wargear.map((item) => [item.ref.id!, item.ref]));
    const explicitCounts = new Map<string, number>();
    for (const item of wargear) {
      explicitCounts.set(
        item.ref.id!,
        (explicitCounts.get(item.ref.id!) ?? 0) + item.count,
      );
    }
    const completed = completeLoadout(
      hit.raw,
      model_count,
      ds.wargearOptionsOf(hit.raw),
      ds.unitCompositionOf(hit.raw)?.models,
      explicitCounts,
    );
    if (completed) {
      const refForId = (id: string): ResolvedRef => {
        const existing = explicitRefs.get(id);
        if (existing) return existing;
        const name =
          hit.weapons.find((weapon) => weapon.id === id)?.name ??
          ds.wargear.get(id)?.name ??
          ds.abilities.get(id)?.name ??
          id;
        return resolved(id, name);
      };
      diag.resolved_weapons += [...completed.counts.keys()].filter(
        (id) => !explicitRefs.has(id),
      ).length;
      wargear = [...completed.counts].map(([id, count]) => ({
        ref: refForId(id),
        count,
      }));
      loadout_groups =
        completed.groups?.map((group) => ({
          model_name: group.model_name,
          count: group.count,
          wargear: group.weapons.map((item) => ({
            ref: refForId(item.id),
            count: item.count,
          })),
        })) ?? undefined;
    }
  }
  if (loadout_groups && loadout_groups.length > 0) {
    const firstGroupPosition = new Map<string, number>();
    for (const group of loadout_groups) {
      for (const item of group.wargear) {
        const key = item.ref.id ?? item.ref.raw_name;
        if (!firstGroupPosition.has(key)) {
          firstGroupPosition.set(key, firstGroupPosition.size);
        }
      }
    }
    wargear = [...wargear].sort((left, right) => {
      const leftKey = left.ref.id ?? left.ref.raw_name;
      const rightKey = right.ref.id ?? right.ref.raw_name;
      return (
        (firstGroupPosition.get(leftKey) ?? Number.MAX_SAFE_INTEGER) -
        (firstGroupPosition.get(rightKey) ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }

  // Loadout legality — the conservative checker over the fully-resolved counts.
  // Gated exactly like grouping (an unresolved unit has no datasheet to check;
  // an unresolved weapon means the counts under-report the list), plus two
  // import-specific reliability gates:
  //   - the parsed model count must sit inside the composition envelope — the
  //     GW flat dialect prints no model line for some units and the parser
  //     infers `model_count: 1`, which would misfire every count-relative
  //     ceiling (so `invalid-model-count` is also filtered);
  //   - `below-min` is filtered — list formats routinely omit a model's
  //     implicit default weapons (a Purifier Squad's purifying flame), so a
  //     floor can't be judged from printed wargear lines.
  // The opt-in `checkRosterLegality`/`checkRoster` APIs keep reporting both.
  if (hit && wargear.every((w) => w.ref.id !== null)) {
    const comp = ds.unitCompositionOf(hit.raw);
    const rows = comp?.models ?? [];
    const envMin = rows.reduce((s, m) => s + (m.min ?? 0), 0);
    const envMax = rows.reduce((s, m) => s + (m.max ?? 0), 0);
    const plausibleCount =
      rows.length === 0 || (model_count >= envMin && model_count <= envMax);
    if (plausibleCount) {
      const counts = new Map<string, number>();
      for (const w of wargear) counts.set(w.ref.id!, (counts.get(w.ref.id!) ?? 0) + w.count);
      const violations = checkUnitLegality(
        hit.raw,
        model_count,
        ds.wargearOptionsOf(hit.raw),
        counts,
        comp?.models,
        comp?.tiers,
      ).filter((v) => v.code !== "invalid-model-count" && v.code !== "below-min");
      if (violations.length > 0) {
        diag.warn(
          "loadout-illegal",
          `Loadout is not buildable from the datasheet's wargear options: ${violations
            .map((v) => `${v.code}:${v.id}`)
            .join(", ")}`,
          parsed.raw_name,
        );
      }
    }
  }

  const keywordOverrides = new Set(parsed.keyword_overrides ?? []);
  if (
    parsed.is_character &&
    hit &&
    hit.raw.role !== "character" &&
    hit.raw.role !== "epic-hero" &&
    !(hit.raw.keywords ?? []).includes("Character")
  ) {
    keywordOverrides.add("Character");
  }

  return {
    ref,
    model_count,
    points: parsed.points,
    is_warlord: parsed.is_warlord,
    ...(keywordOverrides.size ? { keyword_overrides: [...keywordOverrides] } : {}),
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
