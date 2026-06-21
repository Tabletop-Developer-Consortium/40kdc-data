/**
 * chapter-scope.ts — reconcile Space Marine chapter access against the GW MFM
 * dump (the `chapter-scope` ingest subcommand).
 *
 * The repo flattens every Space Marine datasheet into one shared pool
 * (`data/core/adeptus-astartes/units.json`, all `faction_id: "adeptus-astartes"`),
 * and a chapter army is derived by `faction_keywords`: a unit carrying only
 * `["Adeptus Astartes"]` is generic (every chapter may field it); a unit that adds
 * a chapter keyword (e.g. `"Black Templars"`) is locked to that chapter.
 *
 * The dump models the same thing differently — chapters are children of
 * `Adeptus Astartes` and draw the generic pool minus a
 * `faction_keyword_excluded_datasheet` table — so two divergences leak into the
 * flat pool and this subcommand corrects both, fully re-derived from the dump on
 * every reimport (issue #36):
 *
 *  1. EXCLUDE-AND-REPLACE TWINS. Black Templars prints a BT-keyworded *copy* of 9
 *     otherwise-generic units (Repulsor, Land Raider Crusader, …). They are
 *     mechanically identical to the generic datasheet — they differ only by the
 *     army-rule ability, which 40kdc models at the faction level, not per unit. So
 *     in the flat pool a single GENERIC entry is correct (BT still fields it via
 *     the shared pool + its faction vow). Rule: if the dump has any generic
 *     `[Adeptus Astartes]` datasheet for a name, the repo unit's `faction_keywords`
 *     collapse to `["Adeptus Astartes"]`. Only names whose every dump datasheet is
 *     chapter-locked (Helbrecht, Emperor's Champion, …) keep their chapter keyword.
 *
 *  2. GENUINE BARS (no replacement). Where the dump excludes a generic datasheet
 *     from a chapter and prints NO same-name chapter twin (Black Templars cannot
 *     field Librarians; Deathwatch/Space Wolves cannot field the generic
 *     Tactical/Scout/Devastator squads — they have differently-named replacements),
 *     the flat pool can't express the removal. This stamps the new
 *     `excluded_faction_keywords` field on the generic unit so the roster-legality
 *     checker can bar it.
 *
 * Scope: children of `Adeptus Astartes` only. Cross-army ally exclusions in the
 * same dump table (Imperial Knights / Emperor's Children rows) name units outside
 * the AA pool and are a different concept — they never match and are ignored.
 *
 * Like every MFM subcommand, mutations are applied in BOTH dry-run and write modes
 * and routed through {@link applyWrites}, which validates the projected dataset
 * (AJV + integrity) and only persists on --write — a clean dry run guarantees a
 * clean write.
 */
import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import { MfmDump, REPO_ROOT, type DatasheetRow, type DatasheetFactionKeywordRow, type DumpRow } from "./loader.js";
import type { StagedWrite } from "./apply.js";

const UNITS_PATH = path.join(REPO_ROOT, "data", "core", "adeptus-astartes", "units.json");

/** The repo's parent Space Marine faction keyword; every chapter is a child of it. */
const PARENT_KEYWORD = "Adeptus Astartes";

interface FactionKeywordRow extends DumpRow {
  parentFactionKeywordId: string | null;
}
interface ExcludedRow {
  factionKeywordId: string;
  datasheetId: string;
}

interface UnitRecord {
  id: string;
  name: string;
  faction_keywords?: string[];
  excluded_faction_keywords?: string[];
  [k: string]: unknown;
}

/** Dump-derived chapter scope for one repo unit slug. */
export interface ChapterScope {
  /** Source datasheet name (for reports). */
  name: string;
  /** Reconciled faction keywords: `[Adeptus Astartes]` when generic, else `+ chapters`. */
  factionKeywords: string[];
  /** Chapters barred from this otherwise-generic unit (no same-name replacement). */
  excludedKeywords: string[];
}

function readJson<T>(p: string): T[] {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T[]) : [];
}

/** Order-insensitive string-set equality. */
function sameSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  const s = new Set(x);
  return y.every((v) => s.has(v));
}

/**
 * Build, for every Space-Marine-family datasheet name (slugged), its reconciled
 * `faction_keywords` and any chapter bars — derived purely from the dump. Pure
 * (no repo I/O) so it is directly unit-testable.
 */
export function buildChapterScopeCanon(dump: MfmDump): Map<string, ChapterScope> {
  const fkById = dump.byId<FactionKeywordRow>("faction_keyword");
  const fkNameById = new Map<string, string>();
  for (const [id, row] of fkById) {
    const n = dump.enName(row);
    if (n) fkNameById.set(id, n);
  }

  // Parent keyword id + the set of its child chapter ids/names.
  let parentId: string | undefined;
  for (const [id, n] of fkNameById) if (n === PARENT_KEYWORD) parentId = id;
  const childNameById = new Map<string, string>();
  if (parentId) {
    for (const [id, row] of fkById) {
      if (row.parentFactionKeywordId === parentId) {
        const n = fkNameById.get(id);
        if (n) childNameById.set(id, n);
      }
    }
  }
  const childNames = new Set(childNameById.values());

  // datasheetId → its faction-keyword NAME set.
  const kwByDatasheet = new Map<string, Set<string>>();
  for (const r of dump.table<DatasheetFactionKeywordRow>("datasheet_faction_keyword")) {
    const n = fkNameById.get(r.factionKeywordId);
    if (!n) continue;
    (kwByDatasheet.get(r.datasheetId) ?? kwByDatasheet.set(r.datasheetId, new Set()).get(r.datasheetId)!).add(n);
  }

  // Aggregate the SM-family datasheets per slug.
  interface Agg {
    name: string;
    hasGeneric: boolean;
    chapters: Set<string>; // child chapters that print a same-name datasheet
  }
  const bySlug = new Map<string, Agg>();
  const slugOfDatasheet = new Map<string, string>();
  for (const ds of dump.table<DatasheetRow>("datasheet")) {
    if (!ds.id || ds.isLegends) continue;
    const kws = kwByDatasheet.get(ds.id);
    if (!kws || !kws.has(PARENT_KEYWORD)) continue; // SM-family only
    const name = dump.enName(ds);
    if (!name) continue;
    let slug: string;
    try {
      slug = nameToId(name);
    } catch {
      continue;
    }
    slugOfDatasheet.set(ds.id, slug);
    const chapters = [...kws].filter((k) => childNames.has(k));
    const agg = bySlug.get(slug) ?? { name, hasGeneric: false, chapters: new Set<string>() };
    if (chapters.length === 0) agg.hasGeneric = true;
    for (const c of chapters) agg.chapters.add(c);
    bySlug.set(slug, agg);
  }

  // Genuine bars: a (chapter, generic datasheet) exclusion with NO same-name twin.
  const barsBySlug = new Map<string, Set<string>>();
  for (const r of dump.table<ExcludedRow>("faction_keyword_excluded_datasheet")) {
    const chapter = childNameById.get(r.factionKeywordId);
    if (!chapter) continue; // not a chapter of Adeptus Astartes — out of scope
    const slug = slugOfDatasheet.get(r.datasheetId);
    if (!slug) continue; // excluded datasheet isn't in the SM-family pool
    const agg = bySlug.get(slug);
    if (agg && agg.chapters.has(chapter)) continue; // same-name twin exists → exclude-and-replace, not a bar
    (barsBySlug.get(slug) ?? barsBySlug.set(slug, new Set()).get(slug)!).add(chapter);
  }

  const out = new Map<string, ChapterScope>();
  for (const [slug, agg] of bySlug) {
    const factionKeywords = agg.hasGeneric
      ? [PARENT_KEYWORD]
      : [PARENT_KEYWORD, ...[...agg.chapters].sort()];
    const excludedKeywords = [...(barsBySlug.get(slug) ?? [])].sort();
    out.set(slug, { name: agg.name, factionKeywords, excludedKeywords });
  }
  return out;
}

export interface UnitChange {
  id: string;
  field: "faction_keywords" | "excluded_faction_keywords";
  from: string[] | undefined;
  to: string[] | undefined;
}

export interface ChapterScopeReport {
  matched: number;
  factionKeywordsChanged: UnitChange[];
  excludedChanged: UnitChange[];
  /** Repo units in the AA pool with no SM-family datasheet in the dump (review). */
  repoOnly: string[];
  /** Dump SM-family slugs with no repo unit (review). */
  dumpOnly: string[];
  staged: StagedWrite[];
}

export function runChapterScope(dump: MfmDump, _write: boolean): ChapterScopeReport {
  const canon = buildChapterScopeCanon(dump);
  const units = readJson<UnitRecord>(UNITS_PATH);

  const report: ChapterScopeReport = {
    matched: 0,
    factionKeywordsChanged: [],
    excludedChanged: [],
    repoOnly: [],
    dumpOnly: [],
    staged: [],
  };

  const matchedSlugs = new Set<string>();
  let dirty = false;
  for (const u of units) {
    const scope = canon.get(u.id);
    if (!scope) {
      report.repoOnly.push(u.id);
      continue;
    }
    matchedSlugs.add(u.id);
    report.matched++;

    // faction_keywords — rewrite only when the membership set actually differs
    // (avoids reordering the ~160 unchanged units).
    if (!sameSet(u.faction_keywords, scope.factionKeywords)) {
      report.factionKeywordsChanged.push({
        id: u.id,
        field: "faction_keywords",
        from: u.faction_keywords,
        to: scope.factionKeywords,
      });
      u.faction_keywords = scope.factionKeywords;
      dirty = true;
    }

    // excluded_faction_keywords — set when non-empty, drop when the dump bars nothing.
    const curExcl = u.excluded_faction_keywords;
    if (scope.excludedKeywords.length > 0) {
      if (!sameSet(curExcl, scope.excludedKeywords)) {
        report.excludedChanged.push({
          id: u.id,
          field: "excluded_faction_keywords",
          from: curExcl,
          to: scope.excludedKeywords,
        });
        u.excluded_faction_keywords = scope.excludedKeywords;
        dirty = true;
      }
    } else if (curExcl !== undefined) {
      report.excludedChanged.push({
        id: u.id,
        field: "excluded_faction_keywords",
        from: curExcl,
        to: undefined,
      });
      delete u.excluded_faction_keywords;
      dirty = true;
    }
  }

  report.dumpOnly = [...canon.keys()].filter((s) => !matchedSlugs.has(s)).sort();
  if (dirty) report.staged.push({ path: UNITS_PATH, value: units });
  return report;
}

export function buildChapterScopeReport(report: ChapterScopeReport, write: boolean): string {
  const L: string[] = [];
  L.push(`# MFM chapter-scope — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Reconciles Space Marine chapter access in the shared adeptus-astartes pool");
  L.push("from the GW MFM dump (issue #36): collapses Black Templars exclude-and-replace");
  L.push("twins back to generic `faction_keywords`, and stamps `excluded_faction_keywords`");
  L.push("where a chapter is barred from a generic unit with no same-name replacement.");
  L.push("");
  L.push("| Metric | Count |");
  L.push("|---|--:|");
  L.push(`| Units matched | ${report.matched} |`);
  L.push(`| faction_keywords collapsed | ${report.factionKeywordsChanged.length} |`);
  L.push(`| excluded_faction_keywords set | ${report.excludedChanged.length} |`);
  L.push(`| Repo units with no dump datasheet | ${report.repoOnly.length} |`);
  L.push(`| Dump SM datasheets with no repo unit | ${report.dumpOnly.length} |`);
  L.push("");

  const list = (title: string, items: UnitChange[]) => {
    if (!items.length) return;
    L.push(`## ${title}`, "");
    for (const c of items) L.push(`- ${c.id}: [${(c.from ?? []).join(", ")}] → [${(c.to ?? []).join(", ")}]`);
    L.push("");
  };
  list("faction_keywords collapsed to generic", report.factionKeywordsChanged);
  list("excluded_faction_keywords (chapter bars)", report.excludedChanged);

  if (report.repoOnly.length) {
    L.push("## Repo units with no SM-family dump datasheet (review)", "");
    report.repoOnly.forEach((id) => L.push(`- ${id}`));
    L.push("");
  }
  if (report.dumpOnly.length) {
    L.push("## Dump SM-family datasheets with no repo unit (review)", "");
    report.dumpOnly.forEach((id) => L.push(`- ${id}`));
    L.push("");
  }
  return L.join("\n") + "\n";
}
