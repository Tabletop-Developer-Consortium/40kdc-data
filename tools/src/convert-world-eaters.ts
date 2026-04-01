/**
 * Converts World Eaters data from army-assist format to 40kdc-data format.
 *
 * Reads: ~/army-assist/src/assets/json/
 * Writes: data/core/world-eaters/ and data/enrichment/world-eaters/
 *
 * Usage: npx tsx tools/src/convert-world-eaters.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nameToId, parseStratagemType, parsePlayerTurn, mapPhases } from "./converters/id-generator.js";
import { parseMove, parseTargetNumber, parseIntStat, parseInvuln } from "./converters/stat-parser.js";
import { findWEViewIndex, getViewEntries, getPointsForView, splitIntoViews, type SourceAbility } from "./converters/view-selector.js";
import { buildWeaponRegistry, type SourceWargear } from "./converters/weapon-dedup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SOURCE = resolve(process.env.HOME!, "army-assist/src/assets/json");
const GAME_VERSION = { edition: "10th", dataslate: "2025-q3" };
const FACTION_ID = "world-eaters";
const SOURCE_FACTION_ID = "WE";

// ─── Source data types ───────────────────────────────────────────────

interface SourceDatasheet {
  id: string;
  name: string;
  faction_id: string;
  loadout: string;
  transport: string;
  role: string;
  damaged_w: string;
  damaged_description: string;
}

interface SourceModel {
  datasheet_id: string;
  line: string;
  name: string;
  M: string;
  T: string;
  Sv: string;
  inv_sv: string;
  inv_sv_descr: string;
  W: string;
  Ld: string;
  OC: string;
  base_size: string;
  base_size_descr: string;
}

interface SourceKeyword {
  datasheet_id: string;
  keyword: string;
  model: string;
  is_faction_keyword: string;
}

interface SourcePoints {
  datasheet_id: string;
  models: string;
  cost: string;
}

interface SourceLeader {
  leader_id: string;
  attached_id: string;
}

interface SourceEnhancement {
  id: string;
  name: string;
  faction_id: string;
  cost: string;
  detachment: string;
  phases: string[];
}

interface SourceStratagem {
  id: string;
  name: string;
  faction_id: string;
  type: string;
  cp_cost: string;
  turn: string;
  phase: string;
  detachment: string;
  phases: string[];
}

interface SourceDetachmentAbility {
  name: string;
  faction_id: string;
  detachment: string;
  phases: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function readJSON<T>(filename: string): T {
  return JSON.parse(readFileSync(resolve(SOURCE, filename), "utf-8"));
}

function writeOutput(relPath: string, data: unknown): void {
  const outPath = resolve(ROOT, relPath);
  writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  ✓ ${relPath} (${Array.isArray(data) ? data.length : 1} entries)`);
}

/** Determine unit role from keywords and abilities. */
function deriveRole(
  keywords: string[],
  abilities: SourceAbility[],
  name: string
): string | undefined {
  const kw = new Set(keywords.map((k) => k.toLowerCase()));
  if (kw.has("epic hero")) return "epic-hero";

  // Character keyword or Leader core ability → character
  if (kw.has("character")) return "character";
  const hasLeader = abilities.some(
    (a) => a.type === "Core" && a.name === "Leader"
  );
  if (hasLeader) return "character";

  if (kw.has("battleline")) return "battleline";

  // Dedicated transports
  if (
    name.toLowerCase().includes("rhino") ||
    kw.has("dedicated transport")
  )
    return "dedicated-transport";

  return undefined;
}

/** Parse base size string. "32mm" → { shape: "round", diameter: 32 } */
function parseBaseSize(
  s: string
): { shape: string; diameter?: number; width?: number; length?: number } | undefined {
  if (!s || s.trim() === "") return undefined;
  const round = s.match(/(\d+)\s*mm/i);
  if (round) return { shape: "round", diameter: parseInt(round[1], 10) };
  const oval = s.match(/(\d+)\s*x\s*(\d+)/i);
  if (oval)
    return {
      shape: "oval",
      width: parseInt(oval[1], 10),
      length: parseInt(oval[2], 10),
    };
  return undefined;
}

/** Parse transport capacity from transport text. */
function parseTransport(
  s: string
): { capacity: number; keyword_restrictions?: string[]; exclusion_keywords?: string[] } | undefined {
  if (!s || s.trim() === "") return undefined;
  const capMatch = s.match(/capacity[:\s]*(\d+)/i) || s.match(/(\d+)\s+(?:World Eaters|Heretic Astartes|Chaos)/i);
  if (!capMatch) return undefined;
  const capacity = parseInt(capMatch[1], 10);
  const result: { capacity: number; keyword_restrictions?: string[]; exclusion_keywords?: string[] } = { capacity };

  // Common restrictions
  if (/terminator/i.test(s) && /count as 2|two models/i.test(s)) {
    // Terminator counting is a note, not a keyword restriction
  }
  if (/jump pack/i.test(s) && /cannot/i.test(s)) {
    result.exclusion_keywords = ["Jump Pack"];
  }
  return result;
}

// ─── Main conversion ─────────────────────────────────────────────────

function main(): void {
  console.log("Loading source data from army-assist...");

  const datasheets = readJSON<SourceDatasheet[]>("Datasheets.json");
  const allModels = readJSON<SourceModel[]>("Datasheets_models.json");
  const allWargear = readJSON<SourceWargear[]>("Datasheets_wargear.json");
  const allAbilities = readJSON<SourceAbility[]>("Datasheets_abilities.json");
  const allKeywords = readJSON<SourceKeyword[]>("Datasheets_keywords.json");
  const allPoints = readJSON<SourcePoints[]>("Datasheets_points.json");
  const allLeaders = readJSON<SourceLeader[]>("Datasheets_leader.json");
  const enhancements = readJSON<SourceEnhancement[]>("Enhancements.json");
  const stratagems = readJSON<SourceStratagem[]>("Stratagems.json");
  const detachmentAbilities = readJSON<SourceDetachmentAbility[]>(
    "Detachment_abilities.json"
  );

  // Filter to World Eaters
  const weDatasheets = datasheets.filter(
    (d) => d.faction_id === SOURCE_FACTION_ID
  );
  const weIds = new Set(weDatasheets.map((d) => d.id));
  const weIdToName = new Map(weDatasheets.map((d) => [d.id, d.name]));

  console.log(`Found ${weDatasheets.length} World Eaters datasheets\n`);

  // ─── Determine view indices for shared units ───
  const viewIndices = new Map<string, number>();
  for (const ds of weDatasheets) {
    const dsAbilities = allAbilities.filter(
      (a) => a.datasheet_id === ds.id
    );
    viewIndices.set(ds.id, findWEViewIndex(dsAbilities));
  }

  // ─── Build units ───
  console.log("Converting units...");
  const units: Record<string, unknown>[] = [];

  // Collect wargear per unit for weapon registry
  const unitWargearMap = new Map<string, SourceWargear[]>();

  // Collect ability names per unit for ability_ids (names only, IDs wired later)
  const unitAbilityNames = new Map<string, string[]>();

  for (const ds of weDatasheets) {
    const viewIdx = viewIndices.get(ds.id)!;

    // Models
    const dsModels = allModels.filter((m) => m.datasheet_id === ds.id);
    const viewModels = getViewEntries(dsModels, viewIdx);

    // Abilities (for role derivation and ability name collection)
    const dsAbilities = allAbilities.filter(
      (a) => a.datasheet_id === ds.id
    );
    const viewAbilities = getViewEntries(dsAbilities, viewIdx);

    // Collect non-Core, non-Faction ability names for this unit
    const abilityNames = viewAbilities
      .filter((a) => a.type !== "Faction")
      .map((a) => a.name);
    // Deduplicate (e.g., Icon of Khorne appears twice for Berzerkers)
    unitAbilityNames.set(ds.id, [...new Set(abilityNames)]);

    // Keywords
    const dsKeywords = allKeywords.filter(
      (k) => k.datasheet_id === ds.id
    );
    const factionKeywords = [
      ...new Set(
        dsKeywords
          .filter((k) => k.is_faction_keyword === "true")
          .map((k) => k.keyword)
      ),
    ];
    const regularKeywords = [
      ...new Set(
        dsKeywords
          .filter((k) => k.is_faction_keyword !== "true")
          .map((k) => k.keyword)
      ),
    ];

    // Points — select the WE view for shared units
    const allDsPoints = allPoints.filter((p) => p.datasheet_id === ds.id);
    const dsAbilityViews = splitIntoViews(
      allAbilities.filter((a) => a.datasheet_id === ds.id)
    );
    const numViews = dsAbilityViews.length;
    const viewPoints = getPointsForView(allDsPoints, viewIdx, numViews);
    const dsPoints = viewPoints
      .map((p) => ({
        models: parseInt(p.models, 10),
        cost: parseInt(p.cost, 10),
      }))
      .sort((a, b) => a.models - b.models);

    // Wargear for this unit's view
    const dsWargear = allWargear.filter(
      (w) => w.datasheet_id === ds.id
    );
    const viewWargear = getViewEntries(dsWargear, viewIdx);
    unitWargearMap.set(ds.id, viewWargear);

    // Build stat profiles
    const profiles = viewModels.map((m) => {
      const profile: Record<string, unknown> = {
        name: m.name,
        M: parseMove(m.M),
        T: parseIntStat(m.T),
        W: parseIntStat(m.W),
        Sv: parseTargetNumber(m.Sv)!,
        invuln_sv: parseInvuln(m.inv_sv),
        Ld: parseTargetNumber(m.Ld)!,
        OC: parseIntStat(m.OC),
      };
      return profile;
    });

    const role = deriveRole(regularKeywords, viewAbilities, ds.name);
    const baseSize = parseBaseSize(
      viewModels[0]?.base_size ?? ""
    );
    const transport = parseTransport(ds.transport);

    // Model count from points
    const modelMin = dsPoints.length > 0 ? dsPoints[0].models : 1;
    const modelMax =
      dsPoints.length > 0 ? dsPoints[dsPoints.length - 1].models : 1;

    const unitId = nameToId(ds.name);
    const unit: Record<string, unknown> = {
      id: unitId,
      name: ds.name,
      faction_id: FACTION_ID,
      ...(role ? { role } : {}),
      profiles,
      points: dsPoints,
      keywords: regularKeywords,
      faction_keywords: factionKeywords,
      ...(baseSize ? { base_size_mm: baseSize } : {}),
      model_count: { min: modelMin, max: modelMax },
      weapon_ids: [], // populated after weapon registry built
      ability_ids: [], // populated in Phase 3
      ...(transport ? { transport_capacity: transport } : {}),
      game_version: GAME_VERSION,
      is_legend: false,
    };

    units.push(unit);
  }

  // ─── Build weapons ───
  console.log("Converting weapons...");
  const { weapons, unitWeaponIds } = buildWeaponRegistry(
    unitWargearMap,
    GAME_VERSION
  );

  // Wire weapon_ids into units
  for (const unit of units) {
    const dsId = weDatasheets.find((d) => d.name === (unit as { name: string }).name)!.id;
    const weaponIds = unitWeaponIds.get(dsId);
    if (weaponIds) {
      (unit as { weapon_ids: string[] }).weapon_ids = [...weaponIds].sort();
    }
  }

  // ─── Build leader attachments ───
  console.log("Converting leader attachments...");
  // Find all leader entries where both leader and attached are WE units
  const leaderMap = new Map<string, Set<string>>();

  for (const l of allLeaders) {
    if (weIds.has(l.leader_id) && weIds.has(l.attached_id)) {
      const leaderId = nameToId(weIdToName.get(l.leader_id)!);
      const attachedId = nameToId(weIdToName.get(l.attached_id)!);
      if (!leaderMap.has(leaderId)) {
        leaderMap.set(leaderId, new Set());
      }
      leaderMap.get(leaderId)!.add(attachedId);
    }
  }

  const leaderAttachments = [...leaderMap.entries()].map(
    ([leaderId, bodyguards]) => ({
      leader_id: leaderId,
      eligible_bodyguard_ids: [...bodyguards].sort(),
      max_leaders_per_unit: 1,
      game_version: GAME_VERSION,
    })
  );

  // ─── Build detachments ───
  console.log("Converting detachments...");
  const weDetAbilities = detachmentAbilities.filter(
    (d) => d.faction_id === SOURCE_FACTION_ID
  );
  const weEnhancements = enhancements.filter(
    (e) => e.faction_id === SOURCE_FACTION_ID
  );
  const weStratagems = stratagems.filter(
    (s) => s.faction_id === SOURCE_FACTION_ID
  );

  const detachments = weDetAbilities.map((da) => {
    const detId = nameToId(da.detachment);
    const detEnhIds = weEnhancements
      .filter((e) => e.detachment === da.detachment)
      .map((e) => nameToId(e.name));
    const detStratIds = weStratagems
      .filter((s) => s.detachment === da.detachment)
      .map((s) => nameToId(s.name));

    return {
      id: detId,
      name: da.detachment,
      faction_id: FACTION_ID,
      detachment_rule_id: null as string | null, // wired in Phase 3
      enhancement_ids: detEnhIds,
      stratagem_ids: detStratIds,
      game_version: GAME_VERSION,
    };
  });

  // ─── Build enhancements ───
  console.log("Converting enhancements...");
  const enhancementEntities = weEnhancements.map((e) => ({
    id: nameToId(e.name),
    name: e.name,
    detachment_id: nameToId(e.detachment),
    cost: parseInt(e.cost, 10),
    keyword_restrictions: ["World Eaters"],
    ability_id: null as string | null, // wired in Phase 3
    is_unique: true,
    game_version: GAME_VERSION,
  }));

  // ─── Build stratagems ───
  console.log("Converting stratagems...");
  const stratagemEntities = weStratagems.map((s) => {
    const { type } = parseStratagemType(s.type);
    const phases = mapPhases(s.phases);
    const playerTurn = parsePlayerTurn(s.turn);

    return {
      id: nameToId(s.name),
      name: s.name,
      category: "detachment" as const,
      type,
      detachment_id: nameToId(s.detachment),
      cp_cost: parseInt(s.cp_cost, 10),
      phases,
      player_turn: playerTurn,
      timing: "once-per-phase" as const,
      target_restrictions: null as null,
      ability_id: null as string | null, // wired in Phase 3
      game_version: GAME_VERSION,
    };
  });

  // ─── Build phase mappings from source ability phases ───
  console.log("Converting phase mappings...");
  const phaseMappings: Record<string, unknown>[] = [];

  // Unit abilities
  for (const ds of weDatasheets) {
    const viewIdx = viewIndices.get(ds.id)!;
    const dsAbilities = allAbilities.filter(
      (a) => a.datasheet_id === ds.id
    );
    const viewAbilities = getViewEntries(dsAbilities, viewIdx);
    const seen = new Set<string>();

    for (const a of viewAbilities) {
      if (a.type === "Faction") continue;
      const sourceId = nameToId(a.name);
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const sourceType =
        a.type === "Core" ? "ability" :
        a.type === "Wargear" ? "ability" :
        "ability";

      const phases = mapPhases(a.phases);
      if (phases.length > 0) {
        phaseMappings.push({
          source_id: sourceId,
          source_type: sourceType,
          phases,
          game_version: GAME_VERSION,
          authored_by: "40kdc-community",
        });
      }
    }
  }

  // Stratagem phase mappings
  for (const s of weStratagems) {
    const phases = mapPhases(s.phases);
    if (phases.length > 0) {
      phaseMappings.push({
        source_id: nameToId(s.name),
        source_type: "stratagem",
        phases,
        game_version: GAME_VERSION,
        authored_by: "40kdc-community",
      });
    }
  }

  // Enhancement phase mappings
  for (const e of weEnhancements) {
    const phases = mapPhases(e.phases);
    if (phases.length > 0) {
      phaseMappings.push({
        source_id: nameToId(e.name),
        source_type: "enhancement",
        phases,
        game_version: GAME_VERSION,
        authored_by: "40kdc-community",
      });
    }
  }

  // Detachment rule phase mappings
  for (const da of weDetAbilities) {
    const phases = mapPhases(da.phases);
    if (phases.length > 0) {
      phaseMappings.push({
        source_id: nameToId(da.name),
        source_type: "detachment-rule",
        phases,
        game_version: GAME_VERSION,
        authored_by: "40kdc-community",
      });
    }
  }

  // Deduplicate phase mappings (same ability on multiple units)
  const dedupedPhaseMappings = [
    ...new Map(
      phaseMappings.map((pm) => [
        `${(pm as { source_id: string }).source_id}|${(pm as { source_type: string }).source_type}`,
        pm,
      ])
    ).values(),
  ];

  // ─── Build unit compositions ───
  console.log("Generating unit compositions...");

  // Multi-model units need explicit composition breakdowns.
  // Single-model units (vehicles, characters, monsters) get a simple 1-model entry.
  type ModelEntry = {
    name: string;
    profile_name?: string | null;
    min: number;
    max: number;
    default_weapon_ids?: string[];
    is_leader_model: boolean;
  };

  // Manual composition map for multi-model units
  const compositionOverrides: Record<string, ModelEntry[]> = {
    "khorne-berzerkers": [
      { name: "Berzerker Champion", profile_name: "Khorne Berzerker", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "chainblade"], is_leader_model: true },
      { name: "Khorne Berzerker", min: 9, max: 19, default_weapon_ids: ["bolt-pistol", "chainblade"], is_leader_model: false },
    ],
    "jakhals": [
      { name: "Jakhal Pack Leader", profile_name: "Jakhal", min: 1, max: 1, default_weapon_ids: ["autopistol", "jakhal-chainblades"], is_leader_model: true },
      { name: "Dishonoured", profile_name: "Jakhal", min: 1, max: 2, default_weapon_ids: ["mauler-chainblade"], is_leader_model: false },
      { name: "Jakhal", min: 8, max: 17, default_weapon_ids: ["autopistol", "jakhal-chainblades"], is_leader_model: false },
    ],
    "eightbound": [
      { name: "Eightbound Champion", profile_name: "Eightbound", min: 1, max: 1, default_weapon_ids: ["chainblades"], is_leader_model: true },
      { name: "Eightbound", min: 2, max: 5, default_weapon_ids: ["chainblades"], is_leader_model: false },
    ],
    "exalted-eightbound": [
      { name: "Exalted Eightbound Champion", profile_name: "Exalted Eightbound", min: 1, max: 1, default_weapon_ids: ["chainblades"], is_leader_model: true },
      { name: "Exalted Eightbound", min: 2, max: 5, default_weapon_ids: ["chainblades"], is_leader_model: false },
    ],
    "chaos-terminators": [
      { name: "Terminator Champion", profile_name: "World Eaters Terminator", min: 1, max: 1, default_weapon_ids: ["combi-bolter", "accursed-weapon"], is_leader_model: true },
      { name: "Chaos Terminator", profile_name: "World Eaters Terminator", min: 4, max: 4, default_weapon_ids: ["combi-bolter", "accursed-weapon"], is_leader_model: false },
    ],
    "goremongers": [
      { name: "Goremonger Pack Leader", profile_name: "Goremongers", min: 1, max: 1, default_weapon_ids: ["autopistol", "chainblade", "close-combat-weapon"], is_leader_model: true },
      { name: "Goremonger", profile_name: "Goremongers", min: 7, max: 7, default_weapon_ids: ["autopistol", "chainblade", "close-combat-weapon"], is_leader_model: false },
    ],
    "chaos-spawn": [
      { name: "Chaos Spawn", min: 2, max: 2, default_weapon_ids: ["hideous-mutations"], is_leader_model: false },
    ],
  };

  const unitCompositions = units.map((u) => {
    const unitId = (u as { id: string }).id;
    const modelCount = (u as { model_count: { min: number; max: number } }).model_count;

    const override = compositionOverrides[unitId];
    if (override) {
      return {
        unit_id: unitId,
        models: override,
        game_version: GAME_VERSION,
      };
    }

    // Single-model unit (vehicles, characters, monsters)
    const profileName = (u as { profiles: { name: string }[] }).profiles[0]?.name;
    return {
      unit_id: unitId,
      models: [
        {
          name: profileName || (u as { name: string }).name,
          min: modelCount.min,
          max: modelCount.max,
          is_leader_model: false,
        },
      ],
      game_version: GAME_VERSION,
    };
  });

  // ─── Write output ──────────────────────────────────────────────────
  console.log("\nWriting output files...");

  writeOutput("data/core/world-eaters/units.json", units);
  writeOutput("data/core/world-eaters/weapons.json", weapons);
  writeOutput(
    "data/core/world-eaters/leader-attachments.json",
    leaderAttachments
  );
  writeOutput("data/core/world-eaters/detachments.json", detachments);
  writeOutput("data/core/world-eaters/enhancements.json", enhancementEntities);
  writeOutput("data/core/world-eaters/stratagems.json", stratagemEntities);
  writeOutput(
    "data/core/world-eaters/unit-compositions.json",
    unitCompositions
  );
  writeOutput(
    "data/enrichment/world-eaters/phase-mappings.json",
    dedupedPhaseMappings
  );

  // ─── Summary ───
  console.log("\n── Summary ──");
  console.log(`  Units: ${units.length}`);
  console.log(`  Weapons: ${weapons.length}`);
  console.log(`  Leader attachments: ${leaderAttachments.length}`);
  console.log(`  Detachments: ${detachments.length}`);
  console.log(`  Enhancements: ${enhancementEntities.length}`);
  console.log(`  Stratagems: ${stratagemEntities.length}`);
  console.log(`  Unit compositions: ${unitCompositions.length}`);
  console.log(`  Phase mappings: ${dedupedPhaseMappings.length}`);
  console.log("\nDone. Run 'npm run validate' to check output.");
}

main();
