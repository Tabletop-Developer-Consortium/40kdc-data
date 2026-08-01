/**
 * Translates ability DSL entries into plain English descriptions.
 *
 * Thin CLI shell over the shared `translate/effect.ts` describer (the
 * conformance-pinned `ability.print()`); this file only handles file loading
 * and per-ability presentation.
 *
 * Pass `--gw` to load the corresponding `data/_audit/reauthor-input/<faction>.json`
 * and display the official GW source text above each generated description.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeAbility,
  type AbilityAppliesTo,
  type AbilityScope,
  type AbilityTriggerSpec,
  type AbilityUsage,
  type Effect,
} from "../translate/effect.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

interface Ability {
  ability_id: string;
  name: string;
  ability_type?: string;
  behavior?: string;
  detachment_id?: string | null;
  faction_id?: string | null;
  unit_ids?: string[];
  effect: Effect;
  scope?: AbilityScope;
  trigger?: AbilityTriggerSpec | null;
  usage?: AbilityUsage | null;
  applies_to?: AbilityAppliesTo | null;
}

interface AuditEntry {
  ability_id: string;
  src?: { description?: string };
}

export interface TranslateOptions {
  gw?: boolean;
  gwFile?: string;
}

/** Load GW source text keyed by ability_id from a reauthor-input file. */
function loadGwText(abilitiesPath: string, opts: TranslateOptions): Map<string, string> {
  let auditPath = opts.gwFile;
  if (!auditPath) {
    // Auto-detect: infer faction name from the path (e.g. "world-eaters/abilities.json")
    const factionDir = basename(dirname(abilitiesPath));
    auditPath = resolve(REPO_ROOT, "data/_audit/reauthor-input", `${factionDir}.json`);
  }
  if (!existsSync(auditPath)) return new Map();
  const entries: AuditEntry[] = JSON.parse(readFileSync(auditPath, "utf-8"));
  const out = new Map<string, string>();
  for (const e of entries) {
    const text = e.src?.description?.trim();
    if (e.ability_id && text) out.set(e.ability_id, text);
  }
  return out;
}

export async function translateCommand(
  path?: string,
  opts: TranslateOptions = {}
): Promise<void> {
  const filePath = resolve(
    process.cwd(),
    path ?? "../data/enrichment/world-eaters/abilities.json"
  );
  const abilities: Ability[] = JSON.parse(readFileSync(filePath, "utf-8"));

  const gwText = opts.gw ? loadGwText(filePath, opts) : new Map<string, string>();

  for (const a of abilities) {
    const meta: string[] = [];
    if (a.ability_type) meta.push(a.ability_type);
    if (a.behavior) meta.push(a.behavior);
    if (a.detachment_id) meta.push(`detachment: ${a.detachment_id}`);
    if (a.unit_ids?.length) meta.push(`units: ${a.unit_ids.join(", ")}`);

    console.log(`\n═══ ${a.name} [${a.ability_id}] ═══`);
    if (meta.length) console.log(`    ${meta.join(" | ")}`);

    const gw = gwText.get(a.ability_id);
    if (gw) {
      console.log(`\n  [GW]\n${indent(gw, "  ")}`);
      console.log(`\n  [DSL→EN]`);
    }
    console.log(
      describeAbility({
        effect: a.effect,
        scope: a.scope,
        trigger: a.trigger,
        usage: a.usage,
        applies_to: a.applies_to,
      }),
    );
  }

  const gwCoverage = gwText.size > 0
    ? `  (${gwText.size}/${abilities.length} have GW source text)`
    : "";
  console.log(`\n── ${abilities.length} abilities translated ──${gwCoverage}`);
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((l) => prefix + l).join("\n");
}
