import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRoster, Dataset, resolveRosterUnit } from "./data/index.js";
import type { RosterLegality } from "./data/index.js";
import { normalizeName } from "./data/normalize.js";
import { EXPORT_FORMATS, exportRoster } from "./export/index.js";
import type { ExportFormat } from "./export/index.js";
import { tryImportRoster } from "./import/index.js";
import type {
  ResolvedRef,
  Roster,
  RosterFormat,
  RosterUnit,
  Warning,
} from "./import/types.js";

export type FailureOwner =
  | "stale source snapshot"
  | "source master omission/misprojection"
  | "40kdc schema/ingest loss"
  | "source-format parsing/resolution"
  | "serialization loss"
  | "legality/loadout algorithm";

export type GroupingOutcome =
  | "grouped"
  | "unit-unresolved"
  | "wargear-unresolved"
  | "single-model"
  | "no-recorded-defaults"
  | "solver-null";

export interface AuditFailure {
  owner: FailureOwner;
  kind: string;
  detail: string;
  format?: ExportFormat;
}

export interface UnresolvedRef {
  kind: "faction" | "detachment" | "unit" | "enhancement" | "wargear" | "bodyguard";
  raw_name: string;
  unit_index?: number;
}

export interface RoundtripResult {
  format: ExportFormat;
  importable: boolean;
  deterministic: boolean;
  selected_adapter: RosterFormat | null;
  differences: string[];
  error: string | null;
}

export interface WtcAuditRow {
  file: string;
  selected_adapter: RosterFormat | null;
  parse_error: string | null;
  parse_warnings: Warning[];
  unresolved_refs: UnresolvedRef[];
  army_legality: RosterLegality["army"];
  unit_legality: RosterLegality["units"];
  grouping: { unit_index: number; unit_id: string | null; outcome: GroupingOutcome }[];
  roundtrips: RoundtripResult[];
  failures: AuditFailure[];
}

export interface WtcAuditReport {
  generated_from: "tools/src/audit-wtc.ts";
  corpus_root: string;
  summary: {
    files: number;
    parsed: number;
    parse_failures: number;
    warning_failures: number;
    unresolved_refs: number;
    army_legality_errors: number;
    unit_legality_errors: number;
    solver_failures: number;
    nondeterministic_exports: number;
    semantic_roundtrip_differences: number;
    failed_lists: number;
  };
  rows: WtcAuditRow[];
}

const IMPORTABLE_EXPORTS: Record<ExportFormat, boolean> = {
  "newrecruit-json": true,
  "newrecruit-wtc-compact": true,
  "newrecruit-wtc-full": true,
  "newrecruit-simple": true,
  "roster-json": true,
  rosterizer: true,
  "atc-2026-compact": false,
  "atc-2026-full": false,
  yellowscribe: false,
};

function textFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".txt")) out.push(path);
    }
  };
  visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function classifyGrouping(unit: RosterUnit, roster: Roster, ds: Dataset): GroupingOutcome {
  if (unit.loadout_groups) return "grouped";
  const view = unit.ref.id ? resolveRosterUnit(unit, ds, roster.faction_id) : undefined;
  if (!view) return "unit-unresolved";
  if (unit.wargear.some((w) => w.ref.id === null)) return "wargear-unresolved";
  if (unit.model_count <= 1) return "single-model";
  const models = ds.unitCompositionOf(view.raw)?.models;
  const recorded =
    !!models && models.length > 0 && models.every((m) => (m.default_weapon_ids?.length ?? 0) > 0);
  if (!recorded) return "no-recorded-defaults";
  return "solver-null";
}

function unresolvedRef(kind: UnresolvedRef["kind"], ref: ResolvedRef, unitIndex?: number): UnresolvedRef[] {
  if (ref.id !== null) return [];
  return [{ kind, raw_name: ref.raw_name, ...(unitIndex === undefined ? {} : { unit_index: unitIndex }) }];
}

function collectUnresolved(roster: Roster): UnresolvedRef[] {
  const out: UnresolvedRef[] = [];
  if (roster.faction_id === null) out.push({ kind: "faction", raw_name: "(unresolved faction)" });
  for (const detachment of roster.detachments) out.push(...unresolvedRef("detachment", detachment.ref));
  roster.units.forEach((unit, unitIndex) => {
    out.push(...unresolvedRef("unit", unit.ref, unitIndex));
    if (unit.enhancement) out.push(...unresolvedRef("enhancement", unit.enhancement, unitIndex));
    for (const item of unit.wargear) out.push(...unresolvedRef("wargear", item.ref, unitIndex));
    if (unit.leader_attachment) {
      out.push(...unresolvedRef("bodyguard", unit.leader_attachment.bodyguard_ref, unitIndex));
    }
  });
  return out;
}

interface SemanticWargear {
  id: string | null;
  raw_name?: string;
  count: number;
}

function semanticWargear(items: RosterUnit["wargear"]): SemanticWargear[] {
  const counts = new Map<string, SemanticWargear>();
  for (const item of items) {
    const key = item.ref.id ?? `raw:${normalizeName(item.ref.raw_name)}`;
    const current = counts.get(key);
    if (current) {
      current.count += item.count;
    } else {
      counts.set(key, {
        id: item.ref.id,
        ...(item.ref.id === null ? { raw_name: normalizeName(item.ref.raw_name) } : {}),
        count: item.count,
      });
    }
  }
  return [...counts.values()].sort(
    (a, b) =>
      (a.id ?? "").localeCompare(b.id ?? "") ||
      (a.raw_name ?? "").localeCompare(b.raw_name ?? "") ||
      a.count - b.count,
  );
}

function semanticBattleSize(roster: Roster): Roster["battle_size"] {
  if (roster.battle_size !== null) return roster.battle_size;
  const limit =
    roster.points.declared_limit ??
    roster.points.total_reported ??
    roster.points.total_computed;
  if (limit === 1000) return "incursion";
  if (limit === 2000) return "strike-force";
  return null;
}

function semanticPoints(roster: Roster): Roster["points"] {
  const battleSize = semanticBattleSize(roster);
  const totalReported = roster.points.total_reported ?? roster.points.total_computed;
  const declaredLimit =
    roster.points.declared_limit ??
    (battleSize === "incursion"
      ? 1000
      : battleSize === "strike-force"
        ? 2000
        : totalReported);
  const detachmentCap =
    roster.points.detachment_cap ??
    (battleSize === "incursion" ? 2 : battleSize === "strike-force" ? 3 : null);
  return {
    declared_limit: declaredLimit,
    detachment_cap: detachmentCap,
    total_reported: totalReported,
    total_computed: roster.points.total_computed,
  };
}

function semanticRoster(roster: Roster): unknown {
  return {
    name: roster.name,
    faction_id: roster.faction_id,
    detachments: roster.detachments.map((d) => ({
      id: d.ref.id,
      dp_cost: d.dp_cost,
    })),
    battle_size: semanticBattleSize(roster),
    force_disposition: roster.force_disposition,
    points: semanticPoints(roster),
    units: roster.units.map((u) => ({
      id: u.ref.id,
      model_count: u.model_count,
      points: u.points,
      is_warlord: u.is_warlord,
      enhancement: u.enhancement
        ? {
            id: u.enhancement.id,
            points: u.enhancement_points,
          }
        : null,
      wargear: semanticWargear(u.wargear),
      loadout_groups:
        u.loadout_groups
          ?.map((g) => ({
            model_name: g.model_name === null ? null : normalizeName(g.model_name),
            count: g.count,
            wargear: semanticWargear(g.wargear),
          }))
          .sort(
            (a, b) =>
              (a.model_name ?? "").localeCompare(b.model_name ?? "") ||
              a.count - b.count ||
              JSON.stringify(a.wargear).localeCompare(JSON.stringify(b.wargear)),
          ) ?? null,
      leader_attachment: u.leader_attachment
        ? {
            bodyguard_id: u.leader_attachment.bodyguard_ref.id,
            role: u.leader_attachment.role,
            provisional: u.leader_attachment.provisional,
          }
        : null,
    })),
  };
}

function diffValues(expected: unknown, actual: unknown, path = "$"): string[] {
  if (Object.is(expected, actual)) return [];
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    }
    const out: string[] = [];
    if (expected.length !== actual.length) {
      out.push(`${path}.length: expected ${expected.length}, got ${actual.length}`);
    }
    for (let i = 0; i < Math.min(expected.length, actual.length); i += 1) {
      out.push(...diffValues(expected[i], actual[i], `${path}[${i}]`));
    }
    return out;
  }
  if (typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null) {
    const left = expected as Record<string, unknown>;
    const right = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => diffValues(left[key], right[key], `${path}.${key}`));
  }
  return [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

function auditRoundtrips(roster: Roster, ds: Dataset): RoundtripResult[] {
  const expected = semanticRoster(roster);
  return EXPORT_FORMATS.map(({ id }) => {
    const importable = IMPORTABLE_EXPORTS[id];
    try {
      const first = exportRoster(roster, id, ds);
      const deterministic = first === exportRoster(roster, id, ds);
      if (!importable) {
        return {
          format: id,
          importable,
          deterministic,
          selected_adapter: null,
          differences: [],
          error: null,
        };
      }
      const imported = tryImportRoster(first, { dataset: ds });
      if (!imported.ok) {
        return {
          format: id,
          importable,
          deterministic,
          selected_adapter: null,
          differences: [],
          error: `${imported.reason}: ${imported.message}`,
        };
      }
      return {
        format: id,
        importable,
        deterministic,
        selected_adapter: imported.format,
        differences: diffValues(expected, semanticRoster(imported.roster)),
        error: null,
      };
    } catch (error) {
      return {
        format: id,
        importable,
        deterministic: false,
        selected_adapter: null,
        differences: [],
        error: (error as Error).message,
      };
    }
  });
}

function ownerForWarning(warning: Warning): FailureOwner {
  if (warning.code === "loadout-illegal") return "legality/loadout algorithm";
  return "source-format parsing/resolution";
}

function rowForFile(file: string, corpusRoot: string, ds: Dataset): WtcAuditRow {
  const text = readFileSync(file, "utf8");
  const imported = tryImportRoster(text, { dataset: ds });
  const base = {
    file: relative(corpusRoot, file),
    parse_warnings: [] as Warning[],
    unresolved_refs: [] as UnresolvedRef[],
    army_legality: [] as RosterLegality["army"],
    unit_legality: [] as RosterLegality["units"],
    grouping: [] as WtcAuditRow["grouping"],
    roundtrips: [] as RoundtripResult[],
    failures: [] as AuditFailure[],
  };
  if (!imported.ok) {
    const detail = `${imported.reason}: ${imported.message}`;
    return {
      ...base,
      selected_adapter: null,
      parse_error: detail,
      failures: [{ owner: "source-format parsing/resolution", kind: "parse", detail }],
    };
  }

  const roster = imported.roster;
  const unresolved = collectUnresolved(roster);
  const legality = checkRoster(roster, ds);
  const grouping = roster.units.map((unit, unitIndex) => ({
    unit_index: unitIndex,
    unit_id: unit.ref.id,
    outcome: classifyGrouping(unit, roster, ds),
  }));
  const roundtrips = auditRoundtrips(roster, ds);
  const failures: AuditFailure[] = [];

  for (const warning of roster.diagnostics.warnings) {
    if (warning.code === "leader-attachment-inferred") continue;
    failures.push({
      owner: ownerForWarning(warning),
      kind: `warning:${warning.code}`,
      detail: warning.message,
    });
  }
  for (const ref of unresolved) {
    failures.push({
      owner: "source-format parsing/resolution",
      kind: `unresolved:${ref.kind}`,
      detail: `${ref.raw_name}${ref.unit_index === undefined ? "" : ` at unit ${ref.unit_index}`}`,
    });
  }
  for (const violation of legality.army.filter((v) => v.severity === "error")) {
    failures.push({
      owner: "legality/loadout algorithm",
      kind: `army:${violation.code}`,
      detail: violation.message,
    });
  }
  for (const unit of legality.units) {
    for (const violation of unit.violations) {
      failures.push({
        owner: "legality/loadout algorithm",
        kind: `unit:${violation.code}`,
        detail: `${unit.unitId}: ${violation.message}`,
      });
    }
  }
  for (const group of grouping.filter((g) => g.outcome === "solver-null")) {
    failures.push({
      owner: "legality/loadout algorithm",
      kind: "solver-null",
      detail: `unit ${group.unit_index} (${group.unit_id ?? "unresolved"})`,
    });
  }
  for (const result of roundtrips) {
    if (!result.deterministic) {
      failures.push({
        owner: "serialization loss",
        kind: "nondeterministic-export",
        detail: result.error ?? "successive serializations differ",
        format: result.format,
      });
    }
    if (result.importable && result.error) {
      failures.push({
        owner: "serialization loss",
        kind: "roundtrip-import",
        detail: result.error,
        format: result.format,
      });
    }
    if (result.differences.length > 0) {
      failures.push({
        owner: "serialization loss",
        kind: "roundtrip-semantic-difference",
        detail: result.differences.join("; "),
        format: result.format,
      });
    }
  }

  return {
    ...base,
    selected_adapter: imported.format,
    parse_error: null,
    parse_warnings: roster.diagnostics.warnings,
    unresolved_refs: unresolved,
    army_legality: legality.army,
    unit_legality: legality.units,
    grouping,
    roundtrips,
    failures,
  };
}

export function auditWtcCorpus(corpusRoot: string): WtcAuditReport {
  const root = resolve(corpusRoot);
  const listRoot = resolve(root, "lists");
  const files = textFiles(listRoot);
  const ds = Dataset.embedded();
  const rows = files.map((file) => rowForFile(file, root, ds));
  const parsedRows = rows.filter((row) => row.parse_error === null);
  return {
    generated_from: "tools/src/audit-wtc.ts",
    corpus_root: root,
    summary: {
      files: rows.length,
      parsed: parsedRows.length,
      parse_failures: rows.length - parsedRows.length,
      warning_failures: parsedRows.reduce(
        (sum, row) =>
          sum + row.parse_warnings.filter((warning) => warning.code !== "leader-attachment-inferred").length,
        0,
      ),
      unresolved_refs: parsedRows.reduce((sum, row) => sum + row.unresolved_refs.length, 0),
      army_legality_errors: parsedRows.reduce(
        (sum, row) => sum + row.army_legality.filter((violation) => violation.severity === "error").length,
        0,
      ),
      unit_legality_errors: parsedRows.reduce(
        (sum, row) => sum + row.unit_legality.reduce((n, unit) => n + unit.violations.length, 0),
        0,
      ),
      solver_failures: parsedRows.reduce(
        (sum, row) => sum + row.grouping.filter((group) => group.outcome === "solver-null").length,
        0,
      ),
      nondeterministic_exports: parsedRows.reduce(
        (sum, row) => sum + row.roundtrips.filter((result) => !result.deterministic).length,
        0,
      ),
      semantic_roundtrip_differences: parsedRows.reduce(
        (sum, row) => sum + row.roundtrips.reduce((n, result) => n + result.differences.length, 0),
        0,
      ),
      failed_lists: rows.filter((row) => row.failures.length > 0).length,
    },
    rows,
  };
}

function usage(): never {
  throw new Error("usage: npm run audit:wtc -- <corpus-root> --out <json-path>");
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]).replace(/\.\w+$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.\w+$/, "");

if (isMain) {
  const args = process.argv.slice(2);
  const corpusRoot = args[0];
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!corpusRoot || !outPath || outIndex !== 1 || args.length !== 3) usage();

  const report = auditWtcCorpus(corpusRoot);
  const destination = resolve(outPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  if (
    report.summary.files !== 368 ||
    report.summary.parsed !== 368 ||
    report.summary.failed_lists !== 0
  ) {
    process.exitCode = 1;
  }
}
