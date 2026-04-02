/**
 * Generic faction converter: army-assist → 40kdc-data format.
 *
 * Usage: npx tsx tools/src/convert-faction.ts <faction-id>
 * Example: npx tsx tools/src/convert-faction.ts emperors-children
 *
 * Faction configs are registered via side-effect imports from ./converters/configs/.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nameToId, parseStratagemType, parsePlayerTurn, mapPhases } from "./converters/id-generator.js";
import { parseMove, parseTargetNumber, parseIntStat, parseInvuln } from "./converters/stat-parser.js";
import { findFactionViewIndex, getViewEntries, getPointsForView, splitIntoViews, type SourceAbility } from "./converters/view-selector.js";
import { buildWeaponRegistry, type SourceWargear } from "./converters/weapon-dedup.js";
import { getKeywordsForFaction, type SourceKeyword } from "./converters/keyword-filter.js";
import { type FactionConfig, getFactionConfig, listFactions } from "./converters/faction-config.js";

// Register all faction configs
import "./converters/configs/world-eaters.js";
import "./converters/configs/emperors-children.js";
import "./converters/configs/chaos-knights.js";
import "./converters/configs/imperial-knights.js";
import "./converters/configs/leagues-of-votann.js";
import "./converters/configs/drukhari.js";
import "./converters/configs/genestealer-cults.js";
import "./converters/configs/grey-knights.js";
import "./converters/configs/thousand-sons.js";
import "./converters/configs/death-guard.js";
import "./converters/configs/adeptus-custodes.js";
import "./converters/configs/adepta-sororitas.js";
import "./converters/configs/agents-of-the-imperium.js";
import "./converters/configs/adeptus-mechanicus.js";
import "./converters/configs/tau-empire.js";
import "./converters/configs/tyranids.js";
import "./converters/configs/necrons.js";
import "./converters/configs/chaos-daemons.js";
import "./converters/configs/orks.js";
import "./converters/configs/aeldari.js";
import "./converters/configs/chaos-space-marines.js";
import "./converters/configs/astra-militarum.js";
import "./converters/configs/adeptus-astartes.js";
import "./converters/configs/blood-angels.js";
import "./converters/configs/dark-angels.js";
import "./converters/configs/space-wolves.js";
import "./converters/configs/black-templars.js";
import "./converters/configs/deathwatch.js";
import "./converters/configs/ultramarines.js";
import "./converters/configs/imperial-fists.js";
import "./converters/configs/crimson-fists.js";
import "./converters/configs/iron-hands.js";
import "./converters/configs/raven-guard.js";
import "./converters/configs/salamanders.js";
import "./converters/configs/white-scars.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SOURCE = resolve(process.env.HOME!, "army-assist/src/assets/json");
const GAME_VERSION = { edition: "10th", dataslate: "2025-q3" };

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

  if (kw.has("character")) return "character";
  const hasLeader = abilities.some(
    (a) => a.type === "Core" && a.name === "Leader"
  );
  if (hasLeader) return "character";

  if (kw.has("battleline")) return "battleline";

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
  // Match "capacity of N" or "N <FACTION> INFANTRY"
  const capMatch = s.match(/capacity\s*(?:of\s*)?(\d+)/i) || s.match(/(\d+)\s+\S[\S\s]*?\s+(?:infantry|model)/i);
  if (!capMatch) return undefined;
  const capacity = parseInt(capMatch[1], 10);
  const result: { capacity: number; keyword_restrictions?: string[]; exclusion_keywords?: string[] } = { capacity };

  if (/jump pack/i.test(s) && /cannot/i.test(s)) {
    result.exclusion_keywords = ["Jump Pack"];
  }
  return result;
}

// ─── Main conversion ─────────────────────────────────────────────────

export function convertFaction(config: FactionConfig): void {
  const { sourceFactionId, factionId, factionName, factionAbilityName } = config;

  console.log(`Converting ${factionName} (${sourceFactionId} → ${factionId})...`);
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

  // Filter to target faction, skip datasheets with no model data (metadata entries)
  const modelDatasheetIds = new Set(allModels.map((m) => m.datasheet_id));
  const factionDatasheets = datasheets.filter(
    (d) => d.faction_id === sourceFactionId && modelDatasheetIds.has(d.id)
  );
  const factionIds = new Set(factionDatasheets.map((d) => d.id));
  const idToName = new Map(factionDatasheets.map((d) => [d.id, d.name]));

  console.log(`Found ${factionDatasheets.length} ${factionName} datasheets\n`);

  // ─── Determine view indices for shared units ───
  const viewIndices = new Map<string, number>();
  for (const ds of factionDatasheets) {
    const dsAbilities = allAbilities.filter(
      (a) => a.datasheet_id === ds.id
    );
    viewIndices.set(ds.id, findFactionViewIndex(dsAbilities, factionAbilityName));
  }

  // ─── Build units ───
  console.log("Converting units...");
  const units: Record<string, unknown>[] = [];

  const unitWargearMap = new Map<string, SourceWargear[]>();
  const unitAbilityNames = new Map<string, string[]>();

  for (const ds of factionDatasheets) {
    const viewIdx = viewIndices.get(ds.id)!;

    // Models
    const dsModels = allModels.filter((m) => m.datasheet_id === ds.id);
    const viewModels = getViewEntries(dsModels, viewIdx);

    // Abilities (for role derivation and ability name collection)
    const dsAbilities = allAbilities.filter(
      (a) => a.datasheet_id === ds.id
    );
    const viewAbilities = getViewEntries(dsAbilities, viewIdx);

    const abilityNames = viewAbilities
      .filter((a) => a.type !== "Faction")
      .map((a) => a.name);
    unitAbilityNames.set(ds.id, [...new Set(abilityNames)]);

    // Keywords — use faction-aware filtering for shared units
    const dsKeywords = allKeywords.filter(
      (k) => k.datasheet_id === ds.id
    );
    const { factionKeywords, regularKeywords } = getKeywordsForFaction(
      dsKeywords,
      factionName
    );

    // Points — select the correct view for shared units
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

    const modelMin = dsPoints.length > 0 ? dsPoints[0].models : 1;
    const modelMax =
      dsPoints.length > 0 ? dsPoints[dsPoints.length - 1].models : 1;

    const unitId = nameToId(ds.name);
    const unit: Record<string, unknown> = {
      id: unitId,
      name: ds.name,
      faction_id: factionId,
      ...(role ? { role } : {}),
      profiles,
      points: dsPoints,
      keywords: regularKeywords,
      faction_keywords: factionKeywords,
      ...(baseSize ? { base_size_mm: baseSize } : {}),
      model_count: { min: modelMin, max: modelMax },
      weapon_ids: [],
      ability_ids: [],
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
    const dsId = factionDatasheets.find((d) => d.name === (unit as { name: string }).name)!.id;
    const weaponIds = unitWeaponIds.get(dsId);
    if (weaponIds) {
      (unit as { weapon_ids: string[] }).weapon_ids = [...weaponIds].sort();
    }
  }

  // ─── Build leader attachments ───
  console.log("Converting leader attachments...");
  const leaderMap = new Map<string, Set<string>>();

  for (const l of allLeaders) {
    if (factionIds.has(l.leader_id) && factionIds.has(l.attached_id)) {
      const leaderId = nameToId(idToName.get(l.leader_id)!);
      const attachedId = nameToId(idToName.get(l.attached_id)!);
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
  const factionDetAbilities = detachmentAbilities.filter(
    (d) => d.faction_id === sourceFactionId
  );
  let factionEnhancements = enhancements.filter(
    (e) => e.faction_id === sourceFactionId
  );
  let factionStratagems = stratagems.filter(
    (s) => s.faction_id === sourceFactionId
  );

  // Deduplicate detachments (some have multiple ability entries per detachment)
  let detachmentNames = [...new Set(factionDetAbilities.map((da) => da.detachment))];

  // Apply detachment filter for subfactions
  if (config.detachmentFilter) {
    detachmentNames = detachmentNames.filter((d) =>
      config.detachmentFilter!.includes(d)
    );
    // Also filter enhancements and stratagems to matching detachments
    const allowedDetachments = new Set(config.detachmentFilter);
    factionEnhancements = factionEnhancements.filter((e) => allowedDetachments.has(e.detachment));
    factionStratagems = factionStratagems.filter((s) => allowedDetachments.has(s.detachment));
  }

  const detachments = detachmentNames.map((detName) => {
    const detId = nameToId(detName);
    const detEnhIds = factionEnhancements
      .filter((e) => e.detachment === detName)
      .map((e) => nameToId(e.name));
    const detStratIds = factionStratagems
      .filter((s) => s.detachment === detName)
      .map((s) => nameToId(s.name));

    return {
      id: detId,
      name: detName,
      faction_id: factionId,
      detachment_rule_id: null as string | null,
      enhancement_ids: detEnhIds,
      stratagem_ids: detStratIds,
      game_version: GAME_VERSION,
    };
  });

  // ─── Build enhancements ───
  console.log("Converting enhancements...");
  const enhancementEntities = factionEnhancements.map((e) => ({
    id: nameToId(e.name),
    name: e.name,
    detachment_id: nameToId(e.detachment),
    cost: parseInt(e.cost, 10),
    keyword_restrictions: [factionName],
    ability_id: null as string | null,
    is_unique: true,
    game_version: GAME_VERSION,
  }));

  // ─── Build stratagems ───
  console.log("Converting stratagems...");
  const stratagemEntities = factionStratagems.map((s) => {
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
      ability_id: null as string | null,
      game_version: GAME_VERSION,
    };
  });

  // ─── Build phase mappings from source ability phases ───
  console.log("Converting phase mappings...");
  const phaseMappings: Record<string, unknown>[] = [];

  // Unit abilities
  for (const ds of factionDatasheets) {
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
  for (const s of factionStratagems) {
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
  for (const e of factionEnhancements) {
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
  for (const da of factionDetAbilities) {
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

  // Deduplicate phase mappings
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

  const unitCompositions = units.map((u) => {
    const unitId = (u as { id: string }).id;
    const modelCount = (u as { model_count: { min: number; max: number } }).model_count;

    const override = config.compositionOverrides[unitId];
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

  // ─── Generate factions.json ───
  const factionEntity = [
    {
      id: factionId,
      name: factionName,
      parent_faction_id: config.parentFactionId,
      game_version: GAME_VERSION,
      keywords: config.factionKeywords,
      aliases: config.aliases,
      faction_rule_id: config.factionRuleId,
    },
  ];

  // ─── Write output ──────────────────────────────────────────────────
  const coreDir = `data/core/${factionId}`;
  const enrichDir = `data/enrichment/${factionId}`;
  mkdirSync(resolve(ROOT, coreDir), { recursive: true });
  mkdirSync(resolve(ROOT, enrichDir), { recursive: true });

  console.log("\nWriting output files...");

  writeOutput(`${coreDir}/factions.json`, factionEntity);
  if (!config.skipUnits) {
    writeOutput(`${coreDir}/units.json`, units);
    writeOutput(`${coreDir}/weapons.json`, weapons);
    writeOutput(`${coreDir}/leader-attachments.json`, leaderAttachments);
    writeOutput(`${coreDir}/unit-compositions.json`, unitCompositions);
  }
  writeOutput(`${coreDir}/detachments.json`, detachments);
  writeOutput(`${coreDir}/enhancements.json`, enhancementEntities);
  writeOutput(`${coreDir}/stratagems.json`, stratagemEntities);
  if (!config.skipUnits) {
    writeOutput(`${enrichDir}/phase-mappings.json`, dedupedPhaseMappings);
  }

  // ─── Summary ───
  console.log(`\n── ${factionName} Summary ──`);
  if (!config.skipUnits) {
    console.log(`  Units: ${units.length}`);
    console.log(`  Weapons: ${weapons.length}`);
    console.log(`  Leader attachments: ${leaderAttachments.length}`);
    console.log(`  Unit compositions: ${unitCompositions.length}`);
  }
  console.log(`  Detachments: ${detachments.length}`);
  console.log(`  Enhancements: ${enhancementEntities.length}`);
  console.log(`  Stratagems: ${stratagemEntities.length}`);
  if (!config.skipUnits) {
    console.log(`  Phase mappings: ${dedupedPhaseMappings.length}`);
  }
  console.log("\nDone. Run 'npm run validate' to check output.");
}

// ─── CLI entry point ─────────────────────────────────────────────────

// Only run CLI when this module is the entry point (not when imported)
const isMain = process.argv[1] &&
  resolve(process.argv[1]).replace(/\.\w+$/, "") ===
  fileURLToPath(import.meta.url).replace(/\.\w+$/, "");

if (isMain) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    console.log("Usage: npx tsx tools/src/convert-faction.ts <faction-id>");
    console.log(`Available factions: ${listFactions().join(", ")}`);
    process.exit(args[0] === "--help" ? 0 : 1);
  }

  const factionIdArg = args[0];
  const factionConfig = getFactionConfig(factionIdArg);
  convertFaction(factionConfig);
}
