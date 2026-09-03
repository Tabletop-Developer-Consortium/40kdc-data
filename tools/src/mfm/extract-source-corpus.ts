/**
 * extract-source-corpus.ts — build the `audit:source-digest` /
 * `backfill:source-digest` input corpus from contributor-owned sources.
 *
 * The digest commands take a faction-scoped corpus of source strings
 * (`{ faction_id: { ability_id: source } }`) and never read source prose from
 * the repository, because that prose is GW's. This tool assembles that corpus
 * from the two sources a contributor holds locally:
 *
 *   1. the out-of-repo `40kdc-abilities` store, keyed by `ability_id` — either
 *      a single `raw_text`, or the stratagem-shaped `when`/`target`/`effect`/
 *      `restrictions` quartet;
 *   2. the GW MFM dump (`_private/dump.json`), for the annotations the store
 *      has not been backfilled with yet.
 *
 * Output goes to `_private/source-corpus.json` (git-ignored — it carries GW
 * text). IP: nothing this tool writes goes into committed `data/**`.
 *
 * Resolution is exact-identity first and ambiguity-intolerant. A candidate is
 * only accepted when the lookup yields exactly one distinct source string; two
 * dump rows sharing an ability name (Orks have two different "Full Throttle"
 * datasheet abilities) resolve through the datasheet→unit join, and fall out as
 * unresolved rather than picking whichever row the dump happened to list first.
 * A wrong source is worse than no source: it would be digested and committed as
 * if the annotation had been authored against it.
 *
 * Usage:
 *   npx tsx src/mfm/extract-source-corpus.ts [--store <index.json>] [--out <corpus.json>]
 */
import * as fs from "fs";
import * as path from "path";
import { loadDump, type MfmDump } from "./loader.js";
import { REPO_ROOT } from "./repo-files.js";
import { nameToId } from "../converters/id-generator.js";

const DEFAULT_STORE = path.join(process.env.HOME ?? "", "40kdc-abilities", "index.json");
const DEFAULT_OUT = path.join(REPO_ROOT, "_private", "source-corpus.json");
const ENRICHMENT = path.join(REPO_ROOT, "data", "enrichment");

/** Pools that are not live data: fabricated examples and port-audit scratch. */
const EXCLUDED_DIRS = new Set(["_example", "_port-audit"]);
const CORE_FACTION_ID = "_core";

type Localised = Record<string, string | null | undefined>;

/** Strip the dump's presentation markup; the corpus wants prose, not tags. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&rsquo;|&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function slug(name: string): string | null {
  try {
    return nameToId(name);
  } catch {
    return null;
  }
}

/**
 * Every id spelling a name can plausibly carry.
 *
 * Two divergences make a single slugging pass insufficient:
 *   - the dump suffixes some names with a presentation parenthetical that the
 *     authored id does not carry ("Talons of Butchery (Upgrade)"), and some
 *     authored ids *do* carry it ("Nurgle's Gift (Aura)" → nurgle-s-gift-aura);
 *   - `nameToId` drops an apostrophe ("Martial Ka'tah" → martial-katah) while
 *     older authored ids treat it as a separator (martial-ka-tah).
 */
function slugVariants(name: string | null | undefined): string[] {
  if (typeof name !== "string" || !name.trim()) return [];
  const out = new Set<string>();
  for (const base of [name, name.replace(/\s*\([^)]*\)\s*$/, "")]) {
    for (const v of [base, base.replace(/[’']/g, " ")]) {
      const k = slug(v);
      if (k) out.add(k);
    }
  }
  return [...out];
}

/** Candidate index: key → the distinct source strings found under it. */
class Candidates {
  private readonly byKey = new Map<string, Set<string>>();

  add(key: string, raw: string | null | undefined): void {
    if (typeof raw !== "string") return;
    const text = stripHtml(raw);
    if (!text || text === "-") return;
    let set = this.byKey.get(key);
    if (!set) this.byKey.set(key, (set = new Set()));
    set.add(text);
  }

  /** The single source under `key`, or null when absent or ambiguous. */
  resolve(key: string): string | null {
    const set = this.byKey.get(key);
    if (!set || set.size !== 1) return null;
    return [...set][0];
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }
}

interface DumpIndex {
  /** `<name-slug>-<detachment-slug>` — stratagems and enhancements. */
  detachmentScoped: Candidates;
  /** `<unit-id>|<name-slug>` — datasheet abilities and datasheet rules. */
  unitScoped: Candidates;
  /** `<name-slug>` — unit, faction and wargear rules. */
  bareRule: Candidates;
  /**
   * `<name-slug>` — stratagems and enhancements, kept apart from `bareRule`
   * so a unit ability never resolves to a same-named stratagem. Orks have both
   * a "Breakin' Heads" datasheet ability and stratagem.
   */
  bareDetachment: Candidates;
}

function en(row: unknown): Localised {
  return ((row as { localisations?: Record<string, Localised> }).localisations?.en ?? {}) as Localised;
}

function buildDumpIndex(dump: MfmDump): DumpIndex {
  const detachmentScoped = new Candidates();
  const unitScoped = new Candidates();
  const bareRule = new Candidates();
  const bareDetachment = new Candidates();
  const table = (name: string): Record<string, unknown>[] =>
    dump.table(name as Parameters<MfmDump["table"]>[0]) as unknown as Record<string, unknown>[];

  // A Combat Patrol box reprints an army rule in a cut-down form, so a rule
  // named in both a codex and a box has two different bodies in the dump. The
  // codex is the live rule; the box text would read as drift against it.
  const combatPatrolPublications = new Set<string>();
  for (const row of table("publication")) {
    if (/^Combat Patrol:/i.test(String(en(row).name ?? ""))) combatPatrolPublications.add(String(row.id));
  }
  const isCombatPatrol = (row: Record<string, unknown>): boolean =>
    typeof row.publicationId === "string" && combatPatrolPublications.has(row.publicationId);

  // detachment id → slug, for the composite stratagem/enhancement identity
  const detachmentSlug = new Map<string, string>();
  for (const row of table("detachment")) {
    const s = slug(String(en(row).name ?? ""));
    if (s) detachmentSlug.set(String(row.id), s);
  }

  const addScoped = (names: string[], detId: unknown, source: string | null | undefined): void => {
    const det = typeof detId === "string" ? detachmentSlug.get(detId) : undefined;
    for (const n of names) {
      if (det) detachmentScoped.add(`${n}-${det}`, source);
      bareDetachment.add(n, source);
    }
  };

  for (const row of table("stratagem")) {
    const e = en(row);
    const parts = [e.whenRules, e.targetRules, e.effectRules, e.restrictionRules]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map(stripHtml);
    if (!parts.length) continue;
    addScoped(slugVariants(e.name), row.detachmentId, parts.join("\n"));
  }
  for (const row of table("enhancement")) {
    addScoped(slugVariants(en(row).name), row.detachmentId, en(row).rules);
  }

  // Datasheet abilities are scoped by the datasheet they hang off, because
  // distinct units share ability names. Resolve the join, not the name.
  const datasheetUnitIds = new Map<string, string>();
  for (const row of table("datasheet")) {
    const s = slug(String(en(row).name ?? ""));
    if (s) datasheetUnitIds.set(String(row.id), s);
  }
  const abilityById = new Map<string, Record<string, unknown>>();
  for (const row of table("datasheet_ability")) {
    abilityById.set(String(row.id), row);
    // Not every ability row is reachable through the link table, so index the
    // table itself for the bare fallback rather than only its joined rows.
    for (const n of slugVariants(en(row).name)) bareRule.add(n, en(row).rules);
  }
  for (const link of table("datasheet_datasheet_ability")) {
    const unitId = datasheetUnitIds.get(String(link.datasheetId));
    const ability = abilityById.get(String(link.datasheetAbilityId));
    if (!unitId || !ability) continue;
    // Also index bare, as the fallback for when the dump's datasheet name and
    // the authored unit id disagree ("'Ardmob Wartrakk" vs wartrakk). The
    // ambiguity check still rejects a name two units spell differently.
    for (const n of slugVariants(en(ability).name)) {
      unitScoped.add(`${unitId}|${n}`, en(ability).rules);
      bareRule.add(n, en(ability).rules);
    }
  }
  for (const row of table("datasheet_rule")) {
    const unitId = datasheetUnitIds.get(String(row.datasheetId));
    if (!unitId) continue;
    for (const n of slugVariants(en(row).name)) unitScoped.add(`${unitId}|${n}`, en(row).rules);
  }
  // Sub-abilities inherit their parent's datasheets.
  const datasheetsForAbility = new Map<string, string[]>();
  for (const link of table("datasheet_datasheet_ability")) {
    const unitId = datasheetUnitIds.get(String(link.datasheetId));
    if (!unitId) continue;
    const key = String(link.datasheetAbilityId);
    datasheetsForAbility.set(key, [...(datasheetsForAbility.get(key) ?? []), unitId]);
  }
  for (const row of table("datasheet_sub_ability")) {
    const names = slugVariants(en(row).name);
    for (const unitId of datasheetsForAbility.get(String(row.datasheetAbilityId)) ?? []) {
      for (const n of names) unitScoped.add(`${unitId}|${n}`, en(row).rules);
    }
    for (const n of names) bareRule.add(n, en(row).rules);
  }

  // Faction rules keep their name on the rule row but their prose in the
  // rule-container components that hang off it.
  const componentsForRule = new Map<string, Record<string, unknown>[]>();
  for (const comp of table("rule_container_component")) {
    for (const key of ["armyRuleId", "detachmentRuleId"] as const) {
      const id = comp[key];
      if (typeof id !== "string") continue;
      componentsForRule.set(id, [...(componentsForRule.get(id) ?? []), comp]);
    }
  }
  const ruleText = (id: string): string | null => {
    const comps = [...(componentsForRule.get(id) ?? [])].sort(
      (a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0),
    );
    const parts: string[] = [];
    for (const comp of comps) {
      const e = en(comp);
      // `header` labels a following block and `image` carries only alt text;
      // both are layout, and the accordions repeat per localisation pass.
      for (const field of [e.title, e.textContent] as const) {
        if (typeof field !== "string") continue;
        const text = stripHtml(field);
        if (text && text !== "-" && !parts.includes(text)) parts.push(text);
      }
    }
    return parts.length ? parts.join("\n") : null;
  };
  for (const t of ["army_rule", "detachment_rule"]) {
    for (const row of table(t)) {
      if (isCombatPatrol(row)) continue;
      const source = ruleText(String(row.id));
      for (const n of slugVariants(en(row).name)) bareRule.add(n, source);
    }
  }
  for (const row of table("allegiance_ability")) {
    for (const n of slugVariants(en(row).name)) bareRule.add(n, en(row).rules);
  }
  for (const row of table("wargear_ability")) {
    for (const n of slugVariants(en(row).name)) bareRule.add(n, en(row).rules);
  }
  // Some unit abilities are modelled as wargear the leader carries; the prose
  // lives in `ruleText`, not in any field named like a rule.
  for (const row of table("wargear_item")) {
    for (const n of slugVariants(en(row).name)) bareRule.add(n, en(row).ruleText);
  }

  return { detachmentScoped, unitScoped, bareRule, bareDetachment };
}

/** The store's two record shapes reduced to one source string. */
function storeSource(entry: Record<string, unknown>): string | null {
  if (typeof entry.raw_text === "string" && entry.raw_text.trim()) return entry.raw_text.trim();
  const parts = (["when", "target", "effect", "restrictions"] as const)
    .map((k) => entry[k])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return parts.length ? parts.join("\n") : null;
}

interface Annotation {
  faction_id: string;
  ability_id: string;
  name?: string;
  ability_type?: string;
  unit_ids?: string[];
}

function loadAnnotations(): Annotation[] {
  const out: Annotation[] = [];
  for (const dir of fs.readdirSync(ENRICHMENT).sort()) {
    if (EXCLUDED_DIRS.has(dir)) continue;
    const file = path.join(ENRICHMENT, dir, "abilities.json");
    if (!fs.existsSync(file)) continue;
    const fallback = dir.startsWith("_") ? CORE_FACTION_ID : dir;
    for (const record of JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>[]) {
      const abilityId = (record.ability_id ?? record.id) as string;
      out.push({
        faction_id: (record.faction_id as string) ?? fallback,
        ability_id: abilityId,
        name: record.name as string | undefined,
        ability_type: record.ability_type as string | undefined,
        unit_ids: record.unit_ids as string[] | undefined,
      });
    }
  }
  return out;
}

type Origin = "store" | "dump";

function resolveFromDump(annotation: Annotation, index: DumpIndex): string | null {
  const names = slugVariants(annotation.name);
  // The authored id already carries the detachment for detachment-scoped
  // entities, so it is the most specific key available.
  const direct = index.detachmentScoped.resolve(annotation.ability_id);
  if (direct) return direct;
  for (const unitId of annotation.unit_ids ?? []) {
    for (const n of names) {
      const hit = index.unitScoped.resolve(`${unitId}|${n}`);
      if (hit) return hit;
    }
  }
  const bare =
    annotation.ability_type === "stratagem" || annotation.ability_type === "enhancement"
      ? index.bareDetachment
      : index.bareRule;
  for (const n of [annotation.ability_id, ...names]) {
    const hit = bare.resolve(n);
    if (hit) return hit;
  }
  return null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    if (i === -1) return fallback;
    const value = argv[i + 1];
    if (!value) throw new Error(`${name} requires a value`);
    return value;
  };
  const storePath = flag("--store", DEFAULT_STORE);
  const outPath = flag("--out", DEFAULT_OUT);

  const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, Record<string, unknown>>;
  const index = buildDumpIndex(loadDump());
  const annotations = loadAnnotations();

  const corpus: Record<string, Record<string, string>> = {};
  const counts: Record<Origin, number> = { store: 0, dump: 0 };
  const unresolved: Annotation[] = [];

  for (const annotation of annotations) {
    const entry = store[annotation.ability_id];
    let source = entry ? storeSource(entry) : null;
    let origin: Origin = "store";
    if (!source) {
      source = resolveFromDump(annotation, index);
      origin = "dump";
    }
    if (!source) {
      unresolved.push(annotation);
      continue;
    }
    (corpus[annotation.faction_id] ??= {})[annotation.ability_id] = source;
    counts[origin] += 1;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(corpus, null, 2)}\n`);

  const total = annotations.length;
  const resolved = counts.store + counts.dump;
  console.log(`source corpus — ${resolved}/${total} annotations resolved`);
  console.log(`  store ${counts.store}  dump ${counts.dump}  unresolved ${unresolved.length}`);
  console.log(`  wrote ${path.relative(REPO_ROOT, outPath)}`);
  if (unresolved.length) {
    console.log("\nunresolved (no source in the store or the dump):");
    for (const a of unresolved.sort((x, y) =>
      x.faction_id === y.faction_id
        ? x.ability_id < y.ability_id
          ? -1
          : x.ability_id > y.ability_id
            ? 1
            : 0
        : x.faction_id < y.faction_id
          ? -1
          : 1,
    )) {
      console.log(`  ${a.faction_id}/${a.ability_id}  (${a.ability_type ?? "?"})`);
    }
  }
}

main();
