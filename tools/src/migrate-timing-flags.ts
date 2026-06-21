/**
 * migrate-timing-flags — fold the deprecated `timing-flag` side-table into the
 * owning abilities as `ability.trigger`, then (on --apply) delete the entity's
 * data files.
 *
 * The entity is a flat (source_id, source_type, timing) row that duplicates a
 * fact belonging *on* the ability it describes. Every `timing` value in use is
 * already a member of the canonical `game-event` vocabulary (1:1), so the
 * mechanical mapping is identity; the judgment part (subject/optional/proximity)
 * is authored out-of-band (a Workflow fan-out) and merged here in --apply.
 *
 * Resolution of source_id -> abilities.json ability_id:
 *   - direct:     source_id is an exact ability_id (the 62 ability/faction/det-rule rows)
 *   - bare-slug:  enh/strat rows use a bare name-slug; the DSL entry is
 *                 detachment-scoped (`<slug>-<detachment>`). One bare slug may
 *                 fan out to MANY detachment variants — each gets the trigger.
 *   - override:   two known mis-named orphans, remapped explicitly.
 *   - dangling:   six rows point at entities that exist nowhere in the dataset
 *                 (stale pointers). Unmigratable -> REPORTED, not silently dropped.
 *
 * Modes:
 *   (default)  worklist — resolve + map, write <out>/timing-flag-worklist.json
 *              ([{ability_id, event, behavior, raw_text_present, source_type,
 *              source_id}]) for the authoring workflow; print a resolution report.
 *   --apply    read <out>/authored-triggers.json ({ability_id -> trigger}),
 *              structurally validate each trigger, attach to the matching
 *              abilities.json entry (refusing to overwrite an existing trigger),
 *              then delete timing-flags.json + the _example file.
 *
 * Usage:
 *   npx tsx tools/src/migrate-timing-flags.ts [--out <dir>] [--store <dir>]
 *   npx tsx tools/src/migrate-timing-flags.ts --apply [--out <dir>]
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { slug } from "./pack-blocks.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(__dirname, "../..");
const ENRICH = resolve(REPO, "data/enrichment");
const WE = join(ENRICH, "world-eaters");
const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes("--apply");
const OUT = resolve(REPO, flag("--out") ?? process.env.TIMING_FLAG_OUT ?? "tools/.timing-flag-work");
const STORE_ROOT = resolve(REPO, flag("--store") ?? "../40kdc-abilities");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const readJSON = (p: string): Json => JSON.parse(readFileSync(p, "utf-8"));

const TIMING_FLAGS = join(WE, "timing-flags.json");
const ABILITIES = join(WE, "abilities.json");
const EXAMPLE = join(ENRICH, "_example", "timing-flags.example.json");

// Known mis-named orphans (bare slug -> real detachment-scoped ability_id).
const OVERRIDES: Record<string, string> = {
  "a-worthy-skull-stratagem": "a-worthy-skull-khorne-daemonkin",
  "unleash-hell-enhancement": "unleash-hell-goretrack-onslaught",
};

// game-event enum is the migration target vocabulary; load it so the membership
// assertion tracks the schema rather than a hardcoded copy.
const GAME_EVENTS: Set<string> = (() => {
  const common = readJSON(resolve(REPO, "schemas/$defs/common.schema.json"));
  return new Set<string>(common.$defs["game-event"].enum);
})();
// The one non-identity alias in the full timing enum (unused by the data, but
// mapped defensively so an out-of-set value fails loudly rather than silently).
const TIMING_ALIAS: Record<string, string> = { "before-this-model-removed": "before-bearer-removed" };
const toEvent = (timing: string): string => {
  const ev = TIMING_ALIAS[timing] ?? timing;
  if (!GAME_EVENTS.has(ev)) throw new Error(`timing '${timing}' -> '${ev}' is not a game-event enum member`);
  return ev;
};

const abilities: Json[] = readJSON(ABILITIES);
const byId = new Map<string, Json>();
for (const a of abilities) if (typeof a.ability_id === "string") byId.set(a.ability_id, a);
// bare-slug index: slug -> [ability_id, ...] (detachment-scoped variants)
const bySlug = new Map<string, string[]>();
for (const id of byId.keys()) {
  const i = id.lastIndexOf("-");
  // index every prefix split so `hack-and-slash` -> `hack-and-slash-berzerker-warband`
  for (let cut = id.indexOf("-"); cut > 0; cut = id.indexOf("-", cut + 1)) {
    const pre = id.slice(0, cut);
    if (!bySlug.has(pre)) bySlug.set(pre, []);
    bySlug.get(pre)!.push(id);
  }
  void i;
}

/** resolve a timing-flag source_id to the abilities.json ability_ids it targets. */
function resolveTargets(sourceId: string): string[] {
  if (OVERRIDES[sourceId]) return [OVERRIDES[sourceId]];
  if (byId.has(sourceId)) return [sourceId];
  // bare slug -> all detachment-scoped variants that begin with `<slug>-`
  const variants = (bySlug.get(sourceId) ?? []).filter((id) => id.startsWith(sourceId + "-"));
  return [...new Set(variants)];
}

const storeIds: Set<string> = (() => {
  const p = join(STORE_ROOT, "world-eaters.json");
  if (!existsSync(p)) return new Set();
  const store: Json[] = readJSON(p);
  return new Set<string>(store.map((e) => e.ability_id).filter(Boolean));
})();

function runWorklist(): void {
  const tf: Json[] = readJSON(TIMING_FLAGS);
  const worklist: Json[] = [];
  const dangling: string[] = [];
  const fanouts: string[] = [];
  let resolvedRows = 0;
  for (const r of tf) {
    const event = toEvent(r.timing);
    const targets = resolveTargets(r.source_id);
    if (targets.length === 0) { dangling.push(`${r.source_id} (${r.source_type}, ${r.timing})`); continue; }
    if (targets.length > 1) fanouts.push(`${r.source_id} -> ${targets.length}: ${targets.join(", ")}`);
    resolvedRows++;
    for (const ability_id of targets) {
      const a = byId.get(ability_id);
      worklist.push({
        ability_id,
        event,
        behavior: a?.behavior ?? null,
        raw_text_present: storeIds.has(ability_id),
        source_type: r.source_type,
        source_id: r.source_id,
      });
    }
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "timing-flag-worklist.json"), JSON.stringify(worklist, null, 2) + "\n");
  console.log(`timing-flag rows: ${tf.length}`);
  console.log(`  resolved rows:   ${resolvedRows}  (worklist entries after 1:many fan-out: ${worklist.length})`);
  console.log(`  dangling (no target ability — will NOT migrate): ${dangling.length}`);
  for (const d of dangling) console.log(`     - ${d}`);
  console.log(`  1:many fan-outs: ${fanouts.length}`);
  for (const f of fanouts.slice(0, 40)) console.log(`     - ${f}`);
  console.log(`  with raw-text for depth authoring: ${worklist.filter((w) => w.raw_text_present).length}/${worklist.length}`);
  if (resolvedRows + dangling.length !== tf.length) throw new Error("row accounting mismatch — resolved + dangling != total");
  console.log(`\nworklist -> ${join(OUT, "timing-flag-worklist.json")}`);
}

const SUBJECTS = new Set(["self", "bearer", "friendly-unit", "enemy-unit", "any-unit", "model-in-bearer"]);
const PROX_OF = new Set(["self", "bearer", "attached-unit"]);
/** structural validation mirroring ability.schema.json trigger (the full AJV gate runs in `npm run validate`). */
function validateTrigger(t: Json, id: string): void {
  if (typeof t !== "object" || t === null) throw new Error(`${id}: trigger not an object`);
  const keys = Object.keys(t);
  const allowed = new Set(["event", "subject", "proximity", "condition", "optional", "cost", "window"]);
  for (const k of keys) if (!allowed.has(k)) throw new Error(`${id}: trigger has unknown key '${k}'`);
  if (typeof t.event !== "string" || !GAME_EVENTS.has(t.event)) throw new Error(`${id}: trigger.event invalid: ${t.event}`);
  if (t.subject != null && !SUBJECTS.has(t.subject)) throw new Error(`${id}: trigger.subject invalid: ${t.subject}`);
  if (t.optional != null && typeof t.optional !== "boolean") throw new Error(`${id}: trigger.optional not boolean`);
  if (t.proximity != null) {
    const p = t.proximity;
    if (typeof p !== "object" || typeof p.range !== "number" || p.range <= 0) throw new Error(`${id}: trigger.proximity.range invalid`);
    if (p.of != null && !PROX_OF.has(p.of)) throw new Error(`${id}: trigger.proximity.of invalid: ${p.of}`);
    for (const k of Object.keys(p)) if (k !== "of" && k !== "range") throw new Error(`${id}: trigger.proximity unknown key '${k}'`);
  }
}

function runApply(): void {
  const authoredPath = join(OUT, "authored-triggers.json");
  if (!existsSync(authoredPath)) throw new Error(`missing ${authoredPath} — run the authoring workflow first`);
  const authored: Record<string, Json> = readJSON(authoredPath);
  // sanity: every authored id must still resolve to an ability, and cover exactly the worklist set
  const expected = new Set<string>();
  const tf: Json[] = readJSON(TIMING_FLAGS);
  for (const r of tf) for (const id of resolveTargets(r.source_id)) expected.add(id);
  const missing = [...expected].filter((id) => !(id in authored));
  if (missing.length) throw new Error(`authored-triggers.json missing ${missing.length} ids: ${missing.slice(0, 10).join(", ")}`);

  let attached = 0;
  const collisions: string[] = [];
  for (const [id, trigger] of Object.entries(authored)) {
    const a = byId.get(id);
    if (!a) throw new Error(`authored id has no ability: ${id}`);
    validateTrigger(trigger, id);
    if (a.trigger) { collisions.push(id); continue; }
    a.trigger = trigger;
    attached++;
  }
  if (collisions.length) throw new Error(`refusing to overwrite existing triggers on: ${collisions.join(", ")}`);

  writeFileSync(ABILITIES, JSON.stringify(abilities, null, 2) + "\n");
  rmSync(TIMING_FLAGS);
  if (existsSync(EXAMPLE)) rmSync(EXAMPLE);
  console.log(`attached ${attached} trigger blocks to ${ABILITIES}`);
  console.log(`deleted ${TIMING_FLAGS}`);
  console.log(`deleted ${EXAMPLE}`);
  console.log("APPLIED.");
  void dirname;
}

if (APPLY) runApply();
else runWorklist();
