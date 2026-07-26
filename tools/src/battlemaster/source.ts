/**
 * Battlemaster public-API source layer — snapshot, then read offline.
 *
 * Battlemaster (`battlemaster.online`) publishes the 11e Chapter Approved terrain
 * layouts through its public TTS Map API. Its geometry is authored against the
 * physical cards rather than scraped out of the Event Companion PDF, so it is the
 * better upstream for `data/core/terrain-layouts.json` piece placement.
 *
 * ## Why the TTS API and not the Embed API
 *
 * Battlemaster also documents a *Layout Embed API* (`/v1/public/embed/`) whose
 * `include=geometry` payload would be the obvious fit. That base path is not
 * deployed — every route under it 404s — while `/v1/public/tts/` is live. The TTS
 * "lite" layout payload is in fact the better source anyway: it is pure geometry
 * (inch coordinates + template references + mirror flags), where the Embed API
 * leans on rendered images.
 *
 * ## Snapshot, then read
 *
 * `fetchSnapshot` is the only function here that touches the network. Everything
 * downstream reads {@link loadSnapshot}, so calibration and extraction are
 * reproducible offline and CI never makes an outbound request. The snapshot lands
 * in gitignored `_private/battlemaster/` — the same authoring-time convention as
 * `_private/sources/` for the pack PDFs.
 *
 * ## Wire format
 *
 * Both payloads are positional arrays (the API is a bandwidth-conscious spawner
 * contract). The tuple layouts are decoded once, here, into named shapes so no
 * downstream code indexes a magic integer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../mfm/repo-files.js";

/** Where the snapshot lives. Gitignored; authoring-time only. */
export const SNAPSHOT_DIR = join(REPO_ROOT, "_private", "battlemaster");

const API_BASE = "https://battlemaster.online/v1/public/tts";

/**
 * The Battlemaster account that publishes the Chapter Approved card set. The
 * catalog endpoint is owner-scoped (it lists one owner's public layouts), so the
 * owner is part of the source identity, not an incidental parameter.
 */
export const DEFAULT_OWNER = "superwutz";

/** The five 11e force dispositions, spelled as Battlemaster's archetype ids. */
export const ARCHETYPES = [
  "take-and-hold",
  "disruption",
  "purge-the-foe",
  "priority-assets",
  "reconnaissance",
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

/** One terrain *part* — an individual sprue piece, sized by its artwork bbox. */
export interface BmPart {
  /** Battlemaster's display name, e.g. "Short Barrier". */
  name: string;
  /** Artwork bounding-box extents in inches. */
  width: number;
  height: number;
}

/** One part placed inside a composite template, in the template's local frame. */
export interface BmTemplatePart {
  /** Index into {@link BmTemplateCatalog.parts}. */
  partIndex: number;
  x: number;
  y: number;
  rotation: number;
  mirror: number;
}

/**
 * A composite template: the ruin/terrain-area footprint players place as one
 * unit, made of one or more parts. `sizeClass` is the load-bearing field for us —
 * it is what identifies which 40kdc area template the composite corresponds to.
 */
export interface BmTemplate {
  id: string;
  /** Composite bounding-box extents in inches (`11.503 x 7.003` and friends). */
  width: number;
  height: number;
  parts: BmTemplatePart[];
  /** `br` | `tr` | `sr` | `ll` | `sl` — see `SIZE_CLASS_TO_AREA_TEMPLATE`. */
  sizeClass: string;
  /** Battlemaster's style tag (`d`/`m`/`l`); provenance only, unused here. */
  style: string;
  /** Part-tag summary, e.g. `"co+gh"`. A label, not an authoritative part list. */
  label: string;
}

export interface BmTemplateCatalog {
  /** Catalog identity, e.g. `bm-terrain-11e@1`. */
  id: string;
  /** Declared units; asserted to be inches. */
  units: string;
  /** Declared anchor; asserted to be `c` (board/template centre). */
  anchor: string;
  parts: BmPart[];
  templates: BmTemplate[];
}

/** One placed composite template within a layout. */
export interface BmInstance {
  /** Index into {@link BmTemplateCatalog.templates}. */
  templateIndex: number;
  /** Centre-origin, y-up board inches. */
  x: number;
  y: number;
  rotation: number;
  mirror: number;
  /** Objective marker code (`c1`/`c2`/`n`/`hb`/`hr`…), or null when not one. */
  objectiveCode: string | null;
}

export interface BmLayout {
  /** Battlemaster's own layout id (`terrain-<uuid>`). */
  bmId: string;
  name: string;
  archetypeA: Archetype;
  archetypeB: Archetype;
  slotIndex: number;
  /** Integer key into Battlemaster's Chapter Approved deployment table. */
  deploymentKey: number;
  /** Board preset id, asserted to be `sf60x44`. */
  board: string;
  instances: BmInstance[];
}

export interface BmSnapshot {
  catalog: BmTemplateCatalog;
  layouts: BmLayout[];
}

// ── Tuple decoding ───────────────────────────────────────────────────────────
// The API ships positional arrays. Decode defensively: a silently-shifted field
// would corrupt geometry in a way no schema check downstream could catch.

function num(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${where}: expected a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${where}: expected a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v;
}

function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${where}: expected an array, got ${typeof v}`);
  return v;
}

function decodePart(raw: unknown, i: number): BmPart {
  const t = arr(raw, `part[${i}]`);
  return {
    name: str(t[0], `part[${i}].name`),
    width: num(t[1], `part[${i}].width`),
    height: num(t[2], `part[${i}].height`),
  };
}

function decodeTemplate(raw: unknown, i: number, partCount: number): BmTemplate {
  const t = arr(raw, `template[${i}]`);
  const parts = arr(t[3], `template[${i}].parts`).map((p, j) => {
    const pt = arr(p, `template[${i}].part[${j}]`);
    const partIndex = num(pt[0], `template[${i}].part[${j}].partIndex`);
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= partCount) {
      throw new Error(
        `template[${i}].part[${j}]: partIndex ${partIndex} out of range (${partCount} parts)`,
      );
    }
    return {
      partIndex,
      x: num(pt[1], `template[${i}].part[${j}].x`),
      y: num(pt[2], `template[${i}].part[${j}].y`),
      rotation: num(pt[3], `template[${i}].part[${j}].rotation`),
      mirror: typeof pt[4] === "number" ? pt[4] : 0,
    };
  });
  return {
    id: str(t[0], `template[${i}].id`),
    width: num(t[1], `template[${i}].width`),
    height: num(t[2], `template[${i}].height`),
    parts,
    sizeClass: str(t[4], `template[${i}].sizeClass`),
    style: typeof t[5] === "string" ? t[5] : "",
    label: typeof t[6] === "string" ? t[6] : "",
  };
}

export function decodeTemplateCatalog(payload: unknown): BmTemplateCatalog {
  const raw = payload as Record<string, unknown>;
  const body = (raw.templateCatalog ?? raw) as Record<string, unknown>;
  const units = typeof body.u === "string" ? body.u : "";
  const anchor = typeof body.a === "string" ? body.a : "";
  if (units !== "in") {
    throw new Error(`template catalog declares units "${units}", expected "in"`);
  }
  if (anchor !== "c") {
    throw new Error(`template catalog declares anchor "${anchor}", expected "c" (centre)`);
  }
  const parts = arr(body.q, "template catalog parts").map(decodePart);
  const templates = arr(body.t, "template catalog templates").map((t, i) =>
    decodeTemplate(t, i, parts.length),
  );
  return { id: str(body.id, "template catalog id"), units, anchor, parts, templates };
}

function decodeInstance(raw: unknown, i: number, templateCount: number): BmInstance {
  const t = arr(raw, `instance[${i}]`);
  const templateIndex = num(t[0], `instance[${i}].templateIndex`);
  if (!Number.isInteger(templateIndex) || templateIndex < 0 || templateIndex >= templateCount) {
    throw new Error(
      `instance[${i}]: templateIndex ${templateIndex} out of range (${templateCount} templates)`,
    );
  }
  return {
    templateIndex,
    x: num(t[1], `instance[${i}].x`),
    y: num(t[2], `instance[${i}].y`),
    rotation: num(t[3], `instance[${i}].rotation`),
    mirror: typeof t[4] === "number" ? t[4] : 0,
    objectiveCode: typeof t[5] === "string" ? t[5] : null,
  };
}

function decodeLayout(payload: unknown, templateCount: number): BmLayout {
  const raw = payload as Record<string, unknown>;
  const meta = (raw.layout ?? {}) as Record<string, unknown>;
  const lite = (raw.litePayload ?? {}) as Record<string, unknown>;
  const slot = (meta.chapterApprovedSlot ?? {}) as Record<string, unknown>;
  const board = str(lite.b, "layout board");
  if (board !== "sf60x44") {
    throw new Error(`layout "${String(meta.name)}" declares board "${board}", expected "sf60x44"`);
  }
  if (lite.a !== "c") {
    throw new Error(`layout "${String(meta.name)}" declares anchor "${String(lite.a)}", expected "c"`);
  }
  const archetypeA = str(slot.archetypeA, "archetypeA") as Archetype;
  const archetypeB = str(slot.archetypeB, "archetypeB") as Archetype;
  for (const a of [archetypeA, archetypeB]) {
    if (!ARCHETYPES.includes(a)) throw new Error(`unknown archetype "${a}"`);
  }
  return {
    bmId: str(meta.id, "layout id"),
    name: str(meta.name, "layout name"),
    archetypeA,
    archetypeB,
    slotIndex: num(slot.slotIndex, "slotIndex"),
    deploymentKey: num(meta.chapterApprovedDeploymentKey, "chapterApprovedDeploymentKey"),
    board,
    instances: arr(lite.i, "layout instances").map((x, i) => decodeInstance(x, i, templateCount)),
  };
}

// ── Snapshot ────────────────────────────────────────────────────────────────

/** Stable snapshot filename for one layout slot. */
function slotFile(a: Archetype, b: Archetype, slot: number): string {
  return `${a}__${b}__${slot}.json`;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`);
  const body: unknown = await res.json();
  const err = (body as { error?: { code?: string; message?: string } }).error;
  if (err) throw new Error(`GET ${url} → API error ${err.code}: ${err.message}`);
  return body;
}

/**
 * Fetch the template catalog, the owner's Chapter Approved index, and every
 * indexed layout's lite payload into {@link SNAPSHOT_DIR}. The only networked
 * step in the ingest.
 */
export async function fetchSnapshot(owner: string = DEFAULT_OWNER): Promise<void> {
  mkdirSync(join(SNAPSHOT_DIR, "lite"), { recursive: true });

  const templateCatalog = await getJson(`${API_BASE}/template-catalog`);
  writeFileSync(
    join(SNAPSHOT_DIR, "template-catalog.json"),
    `${JSON.stringify(templateCatalog, null, 2)}\n`,
  );
  const catalog = decodeTemplateCatalog(templateCatalog);
  console.log(
    `[battlemaster] template catalog "${catalog.id}": ` +
      `${catalog.templates.length} templates over ${catalog.parts.length} parts.`,
  );

  const indexUrl = `${API_BASE}/chapter-approved-layouts?owner=${encodeURIComponent(owner)}`;
  const index = (await getJson(indexUrl)) as { layouts?: unknown[] };
  writeFileSync(join(SNAPSHOT_DIR, "catalog.json"), `${JSON.stringify(index, null, 2)}\n`);
  const slots = (index.layouts ?? []).map((l) => {
    const s = ((l as Record<string, unknown>).chapterApprovedSlot ?? {}) as Record<string, unknown>;
    return {
      a: str(s.archetypeA, "index archetypeA") as Archetype,
      b: str(s.archetypeB, "index archetypeB") as Archetype,
      slot: num(s.slotIndex, "index slotIndex"),
    };
  });
  console.log(`[battlemaster] index for owner "${owner}": ${slots.length} layouts.`);

  for (const { a, b, slot } of slots) {
    const url =
      `${API_BASE}/chapter-approved-layout-lite?owner=${encodeURIComponent(owner)}` +
      `&archetypeA=${a}&archetypeB=${b}&slot=${slot}`;
    const payload = await getJson(url);
    // Decode eagerly so a wire-format change fails at fetch time, not later.
    decodeLayout(payload, catalog.templates.length);
    writeFileSync(
      join(SNAPSHOT_DIR, "lite", slotFile(a, b, slot)),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }
  console.log(`[battlemaster] snapshot written to ${SNAPSHOT_DIR}`);
}

/** Read the snapshot from disk. Throws with the fetch hint when it is absent. */
export function loadSnapshot(dir: string = SNAPSHOT_DIR): BmSnapshot {
  const catalogPath = join(dir, "template-catalog.json");
  if (!existsSync(catalogPath)) {
    throw new Error(
      `no Battlemaster snapshot at ${dir} — run \`npm run ingest:battlemaster -- fetch\` first`,
    );
  }
  const catalog = decodeTemplateCatalog(JSON.parse(readFileSync(catalogPath, "utf8")));
  const liteDir = join(dir, "lite");
  const files = existsSync(liteDir)
    ? readdirSync(liteDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
  if (files.length === 0) throw new Error(`snapshot at ${dir} has no lite layouts`);
  const layouts = files.map((f) =>
    decodeLayout(JSON.parse(readFileSync(join(liteDir, f), "utf8")), catalog.templates.length),
  );
  return { catalog, layouts };
}
