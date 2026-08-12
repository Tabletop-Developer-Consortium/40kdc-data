import { BSON } from "bson";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ComposedFeature,
  LayoutPiece,
  Mirror,
  TerrainLayout,
  TerrainTemplate,
  Vec2,
} from "./terrain/resolve.js";
import { resolveLayout } from "./terrain/resolve.js";
import { applyWrites } from "./mfm/apply.js";
import { CORE_DIR, readJsonArray } from "./mfm/repo-files.js";

export const BATTLEMASTER_SPAWNER_WORKSHOP_ID = "3781889191";
export const BATTLEMASTER_SPAWNER_PAGE =
  `https://steamcommunity.com/sharedfiles/filedetails/?id=${BATTLEMASTER_SPAWNER_WORKSHOP_ID}`;
export const BATTLEMASTER_PUBLIC_DATA_DOCS = "https://battlemaster.online/v1/public/docs#tag/data";
const WORKSHOP_DETAILS_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const CACHE_START = "-- BM_BAKED_CACHE_START";
const CACHE_END = "-- BM_BAKED_CACHE_END";
const SOURCE = "battlemaster-11e";
const GAME_VERSION = { edition: "11th", dataslate: "pre-launch-provisional" } as const;
const BOARD = { width: 60, height: 44 } as const;
const ERROR_TOLERANCE = 1e-3;

const DEPLOYMENT_KEY_TO_PATTERN: Record<number, string> = {
  1: "search-and-destroy",
  2: "dawn-of-war",
  3: "hammer-and-anvil",
  4: "crucible-of-battle",
  5: "sweeping-engagement",
  6: "tipping-point",
};
const OBJECTIVE_CODE_TO_ROLE: Record<string, "home" | "expansion" | "center"> = {
  c: "center",
  c1: "center",
  c2: "center",
  n: "expansion",
  hb: "home",
  hr: "home",
  hl: "home",
  ht: "home",
};
const REQUIRED_CACHE_SECTIONS: Record<string, true> = {
  bakedAt: true,
  layoutCatalog: true,
  layoutPayloadCache: true,
  templateCatalog: true,
  version: true,
};

interface TtsSave {
  ObjectStates?: Array<{ Nickname?: string; LuaScript?: string }>;
}
interface LuaField {
  key: string | null;
  value: LuaValue;
}
type LuaValue = null | boolean | number | string | LuaField[];

interface LuaParser {
  readonly text: string;
  index: number;
}

interface RawPart {
  name: string;
  width: number;
  height: number;
}

interface RawTemplatePart {
  partIndex: number;
  x: number;
  y: number;
  rotation: number;
  mirror: number;
}

interface RawComposite {
  id: string;
  width: number;
  height: number;
  parts: RawTemplatePart[];
  sizeClass: string;
  style: string;
  label: string;
}

interface RawTemplateCatalog {
  id: string;
  units: string;
  anchor: string;
  parts: RawPart[];
  composites: RawComposite[];
}

interface RawLayoutInstance {
  templateIndex: number;
  x: number;
  y: number;
  rotation: number;
  mirror: number;
  objectiveCode: string | null;
}

interface RawLayout {
  battlemasterId: string;
  name: string;
  archetypeA: string;
  archetypeB: string;
  slot: number;
  deploymentKey: number;
  board: string;
  instances: RawLayoutInstance[];
}

interface ProjectedPiece extends LayoutPiece {
  objective_role?: "home" | "expansion" | "center";
  is_objective?: boolean;
}

interface ProjectedLayout extends TerrainLayout {
  source: string;
  description: string;
  mission_matchup_id: string;
  variant: number;
  deployment_pattern_id: string;
  pieces: ProjectedPiece[];
  game_version: typeof GAME_VERSION;
}

interface ProjectedTemplate extends TerrainTemplate {
  source: string;
  game_version: typeof GAME_VERSION;
}

export interface BattlemasterProjectionSummary {
  workshop_id: string;
  source_file: string;
  baked_at: string;
  cache_version: number;
  catalog_id: string;
  layouts: number;
  layout_instances: number;
  feature_instances: number;
  feature_templates: number;
  composite_templates: number;
  resolved_pieces: number;
  worst_area_error_inches: number;
  worst_feature_error_inches: number;
}

export interface BattlemasterProjection {
  readonly: true;
  source: {
    kind: "tabletop-simulator-workshop-save";
    workshop_id: string;
    workshop_page: string;
    public_data_docs: string;
    source_file: string;
    baked_at: string;
    cache_version: number;
    catalog_id: string;
  };
  terrain_templates: ProjectedTemplate[];
  terrain_layouts: ProjectedLayout[];
  summary: BattlemasterProjectionSummary;
}

export interface ProjectBattlemasterOptions {
  inputPath?: string;
  fetch?: typeof globalThis.fetch;
}

function fail(message: string): never {
  throw new Error(`Battlemaster projector: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where}: expected an array`);
  return value;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${where}: expected a non-empty string`);
  return value;
}

function number(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${where}: expected a finite number`);
  return value;
}

function integer(value: unknown, where: string): number {
  const n = number(value, where);
  if (!Number.isInteger(n)) fail(`${where}: expected an integer`);
  return n;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tupleValue(tuple: unknown, index: number): unknown {
  if (Array.isArray(tuple)) return tuple[index];
  return record(tuple, "tuple")[String(index + 1)];
}

function tupleArray(value: unknown, where: string): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = record(value, where);
  const keys = Object.keys(obj);
  if (!keys.every((key) => /^\d+$/.test(key))) fail(`${where}: expected a positional array`);
  const ordered = keys.map(Number).sort((a, b) => a - b);
  if (!ordered.every((key, index) => key === index + 1)) fail(`${where}: sparse positional array`);
  return ordered.map((key) => obj[String(key)]);
}

function norm360(degrees: number): number {
  const value = degrees % 360;
  return value < 0 ? value + 360 : value;
}

function round6(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toBoardFrame(x: number, y: number): Vec2 {
  return { x: round6(x + BOARD.width / 2), y: round6(BOARD.height / 2 - y) };
}

function slug(value: string): string {
  const out = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!out) fail(`cannot form an id from ${JSON.stringify(value)}`);
  return out;
}

function layoutId(raw: RawLayout): string {
  if (raw.archetypeA === raw.archetypeB && raw.archetypeA === "take-and-hold") {
    return `take-and-hold-mirror-${raw.slot}`;
  }
  return `${raw.archetypeA}-vs-${raw.archetypeB}-${raw.slot}`;
}

function matchupId(raw: RawLayout): string {
  return `${raw.archetypeA}-vs-${raw.archetypeB}`;
}

function rotateCcwYUp(point: Vec2, degrees: number): Vec2 {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: cosine * point.x - sine * point.y,
    y: sine * point.x + cosine * point.y,
  };
}

function partCentreYUp(part: RawPart, placed: RawTemplatePart): Vec2 {
  const corners: Vec2[] = [
    { x: 0, y: 0 },
    { x: part.width, y: 0 },
    { x: part.width, y: part.height },
    { x: 0, y: part.height },
  ].map((point) => ({ x: placed.mirror ? -point.x : point.x, y: point.y }))
    .map((point) => rotateCcwYUp(point, placed.rotation))
    .map((point) => ({ x: point.x + placed.x, y: point.y + placed.y }));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function skipSpace(parser: LuaParser): void {
  while (/\s/.test(parser.text[parser.index] ?? "")) parser.index += 1;
}

function parseLuaString(parser: LuaParser): string {
  const quote = parser.text[parser.index];
  if (quote !== '"' && quote !== "'") fail(`Lua offset ${parser.index}: expected a string`);
  parser.index += 1;
  let output = "";
  while (parser.index < parser.text.length) {
    const char = parser.text[parser.index++];
    if (char === quote) return output;
    if (char !== "\\") {
      output += char;
      continue;
    }
    const escaped = parser.text[parser.index++];
    const simple: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"',
      "'": "'",
    };
    if (escaped in simple) {
      output += simple[escaped]!;
    } else if (escaped === "z") {
      skipSpace(parser);
    } else if (/\d/.test(escaped ?? "")) {
      let digits = escaped!;
      while (digits.length < 3 && /\d/.test(parser.text[parser.index] ?? "")) {
        digits += parser.text[parser.index++];
      }
      output += String.fromCharCode(Number(digits));
    } else {
      output += escaped ?? "";
    }
  }
  fail("unterminated Lua string");
}

function parseLuaIdentifier(parser: LuaParser): string {
  const start = parser.index;
  while (/[A-Za-z0-9_]/.test(parser.text[parser.index] ?? "")) parser.index += 1;
  if (parser.index === start) fail(`Lua offset ${parser.index}: expected an identifier`);
  return parser.text.slice(start, parser.index);
}

function parseLuaNumber(parser: LuaParser): number {
  const match = parser.text.slice(parser.index).match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
  if (!match) fail(`Lua offset ${parser.index}: expected a number`);
  parser.index += match[0].length;
  return Number(match[0]);
}

function parseLuaTable(parser: LuaParser): LuaField[] {
  parser.index += 1;
  const fields: LuaField[] = [];
  while (true) {
    skipSpace(parser);
    if (parser.text[parser.index] === "}") {
      parser.index += 1;
      return fields;
    }
    let key: string | null = null;
    if (parser.text[parser.index] === "[") {
      parser.index += 1;
      skipSpace(parser);
      key = String(parseLuaValue(parser));
      skipSpace(parser);
      if (parser.text[parser.index++] !== "]") fail(`Lua offset ${parser.index}: expected ]`);
      skipSpace(parser);
      if (parser.text[parser.index++] !== "=") fail(`Lua offset ${parser.index}: expected =`);
    } else {
      const saved = parser.index;
      if (/[A-Za-z_]/.test(parser.text[parser.index] ?? "")) {
        const candidate = parseLuaIdentifier(parser);
        skipSpace(parser);
        if (parser.text[parser.index] === "=") {
          key = candidate;
          parser.index += 1;
        } else {
          parser.index = saved;
        }
      }
    }
    skipSpace(parser);
    fields.push({ key, value: parseLuaValue(parser) });
    skipSpace(parser);
    if (parser.text[parser.index] === "," || parser.text[parser.index] === ";") parser.index += 1;
  }
}

function parseLuaValue(parser: LuaParser): LuaValue {
  skipSpace(parser);
  const char = parser.text[parser.index];
  if (char === "{" ) return parseLuaTable(parser);
  if (char === '"' || char === "'") return parseLuaString(parser);
  if (char === "-" || /\d/.test(char ?? "")) return parseLuaNumber(parser);
  const identifier = parseLuaIdentifier(parser);
  if (identifier === "true") return true;
  if (identifier === "false") return false;
  if (identifier === "nil") return null;
  fail(`Lua offset ${parser.index}: unsupported value ${identifier}`);
}

function luaToJs(value: LuaValue): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 0) return {};
  const hasNamed = value.some((field) => field.key !== null);
  if (!hasNamed) return value.map((field) => luaToJs(field.value));
  const output: Record<string, unknown> = {};
  let implicit = 1;
  for (const field of value) {
    output[field.key ?? String(implicit++)] = luaToJs(field.value);
  }
  const keys = Object.keys(output);
  if (keys.every((key) => /^\d+$/.test(key))) {
    const ordered = keys.map(Number).sort((a, b) => a - b);
    if (ordered.every((key, index) => key === index + 1)) {
      return ordered.map((key) => output[String(key)]);
    }
  }
  return output;
}

export function decodeBakedCache(luaScript: string): Record<string, unknown> {
  const start = luaScript.indexOf(CACHE_START);
  const end = luaScript.indexOf(CACHE_END);
  if (start < 0 || end <= start) fail("the object has no complete BM_BAKED_CACHE block");
  const body = luaScript.slice(start + CACHE_START.length, end);
  const cache: Record<string, unknown> = {};
  for (const statement of body.split(/\r?\n/)) {
    const line = statement.trim();
    if (!line || line === "BM_BAKED_CACHE={}") continue;
    const match = line.match(/^BM_BAKED_CACHE\["((?:[^"\\]|\\.)+)"\](?:\["((?:[^"\\]|\\.)+)"\])?=(.*)$/);
    const sectionMatch = line.match(/^BM_BAKED_CACHE\["((?:[^"\\]|\\.)+)"\]/);
    if (!sectionMatch) fail(`unsupported baked-cache statement: ${line.slice(0, 80)}`);
    const decodeKey = (raw: string): string => parseLuaString({ text: `"${raw}"`, index: 0 });
    const section = decodeKey(sectionMatch[1]!);
    if (!REQUIRED_CACHE_SECTIONS[section]) continue;
    if (!match) fail(`unsupported ${section} statement: ${line.slice(0, 80)}`);
    const nested = match[2] === undefined ? null : decodeKey(match[2]);
    const parser: LuaParser = { text: match[3]!, index: 0 };
    const decoded = luaToJs(parseLuaValue(parser));
    skipSpace(parser);
    if (parser.index !== parser.text.length) fail(`trailing Lua data in ${section}`);
    if (nested === null) {
      cache[section] = decoded;
    } else {
      const target = cache[section];
      if (typeof target !== "object" || target === null || Array.isArray(target)) {
        fail(`${section}: nested assignment before table declaration`);
      }
      (target as Record<string, unknown>)[nested] = decoded;
    }
  }
  return cache;
}

function findSpawnerScript(save: TtsSave): string {
  const objects = save.ObjectStates ?? [];
  const candidates = objects.filter((object) => object.LuaScript?.includes(CACHE_START));
  if (candidates.length !== 1) {
    fail(`expected exactly one object with a baked cache, found ${candidates.length}`);
  }
  return candidates[0]!.LuaScript!;
}
export function decodeSpawnerSave(bytes: Uint8Array): Record<string, unknown> {
  let save: TtsSave;
  try {
    save = BSON.deserialize(bytes) as TtsSave;
  } catch (error) {
    fail(`cannot decode the Tabletop Simulator BSON save: ${(error as Error).message}`);
  }
  return decodeBakedCache(findSpawnerScript(save));
}

function decodeTemplateCatalog(rawValue: unknown): RawTemplateCatalog {
  const raw = record(rawValue, "templateCatalog");
  const units = string(raw.u, "templateCatalog.u");
  const anchor = string(raw.a, "templateCatalog.a");
  if (units !== "in") fail(`templateCatalog.u: expected "in", got ${JSON.stringify(units)}`);
  if (anchor !== "c") fail(`templateCatalog.a: expected centre anchor "c", got ${JSON.stringify(anchor)}`);
  const parts = tupleArray(raw.q, "templateCatalog.q").map((value, index): RawPart => {
    const tuple = tupleArray(value, `templateCatalog.q[${index}]`);
    return {
      name: string(tuple[0], `templateCatalog.q[${index}][0]`),
      width: number(tuple[1], `templateCatalog.q[${index}][1]`),
      height: number(tuple[2], `templateCatalog.q[${index}][2]`),
    };
  });
  const composites = tupleArray(raw.t, "templateCatalog.t").map((value, index): RawComposite => {
    const tuple = tupleArray(value, `templateCatalog.t[${index}]`);
    const placed = tupleArray(tuple[3], `templateCatalog.t[${index}][3]`).map((partValue, partIndex) => {
      const part = tupleArray(partValue, `templateCatalog.t[${index}][3][${partIndex}]`);
      const sourceIndex = integer(part[0], `templateCatalog.t[${index}][3][${partIndex}][0]`);
      if (sourceIndex < 0 || sourceIndex >= parts.length) {
        fail(`templateCatalog.t[${index}][3][${partIndex}]: part index ${sourceIndex} is out of range`);
      }
      return {
        partIndex: sourceIndex,
        x: number(part[1], `templateCatalog.t[${index}][3][${partIndex}][1]`),
        y: number(part[2], `templateCatalog.t[${index}][3][${partIndex}][2]`),
        rotation: number(part[3], `templateCatalog.t[${index}][3][${partIndex}][3]`),
        mirror: typeof part[4] === "number" ? part[4] : 0,
      };
    });
    return {
      id: string(tuple[0], `templateCatalog.t[${index}][0]`),
      width: number(tuple[1], `templateCatalog.t[${index}][1]`),
      height: number(tuple[2], `templateCatalog.t[${index}][2]`),
      parts: placed,
      sizeClass: string(tuple[4], `templateCatalog.t[${index}][4]`),
      style: optionalString(tuple[5]) ?? "",
      label: optionalString(tuple[6]) ?? "",
    };
  });
  return {
    id: string(raw.id, "templateCatalog.id"),
    units,
    anchor,
    parts,
    composites,
  };
}

function decodeLayouts(cache: Record<string, unknown>, templateCount: number): RawLayout[] {
  const catalog = record(cache.layoutCatalog, "layoutCatalog");
  const catalogRows = array(catalog.layouts, "layoutCatalog.layouts");
  const chapterRows = catalogRows.filter((value) => {
    const row = record(value, "layoutCatalog.layouts[]");
    return row.missionPackId === "chapter-approved-2026" && row.chapterApprovedSlot !== undefined;
  });
  const byId = new Map(chapterRows.map((value) => {
    const row = record(value, "layoutCatalog.layouts[]");
    return [string(row.id, "layoutCatalog.layouts[].id"), row] as const;
  }));
  const payloads = record(cache.layoutPayloadCache, "layoutPayloadCache");
  const decoded: RawLayout[] = [];
  for (const value of Object.values(payloads)) {
    const entry = record(value, "layoutPayloadCache[]");
    const payload = record(entry.payload, "layoutPayloadCache[].payload");
    const battlemasterId = string(payload.id, "layoutPayloadCache[].payload.id");
    const meta = byId.get(battlemasterId);
    if (!meta) continue;
    const slot = record(meta.chapterApprovedSlot, `${battlemasterId}.chapterApprovedSlot`);
    const board = string(payload.b, `${battlemasterId}.payload.b`);
    if (board !== "sf60x44") fail(`${battlemasterId}: unsupported board ${JSON.stringify(board)}`);
    if (payload.a !== "c") fail(`${battlemasterId}: expected centre anchor "c"`);
    const instances = tupleArray(payload.i, `${battlemasterId}.payload.i`).map((instanceValue, index) => {
      const instance = tupleArray(instanceValue, `${battlemasterId}.payload.i[${index}]`);
      const templateIndex = integer(instance[0], `${battlemasterId}.payload.i[${index}][0]`);
      if (templateIndex < 0 || templateIndex >= templateCount) {
        fail(`${battlemasterId}.payload.i[${index}]: template index ${templateIndex} is out of range`);
      }
      return {
        templateIndex,
        x: number(instance[1], `${battlemasterId}.payload.i[${index}][1]`),
        y: number(instance[2], `${battlemasterId}.payload.i[${index}][2]`),
        rotation: number(instance[3], `${battlemasterId}.payload.i[${index}][3]`),
        mirror: typeof instance[4] === "number" ? instance[4] : 0,
        objectiveCode: optionalString(instance[5]),
      };
    });
    decoded.push({
      battlemasterId,
      name: string(meta.name, `${battlemasterId}.name`),
      archetypeA: string(slot.archetypeA, `${battlemasterId}.chapterApprovedSlot.archetypeA`),
      archetypeB: string(slot.archetypeB, `${battlemasterId}.chapterApprovedSlot.archetypeB`),
      slot: integer(slot.slotIndex, `${battlemasterId}.chapterApprovedSlot.slotIndex`),
      deploymentKey: integer(meta.chapterApprovedDeploymentKey, `${battlemasterId}.chapterApprovedDeploymentKey`),
      board,
      instances,
    });
  }
  decoded.sort((a, b) => layoutId(a).localeCompare(layoutId(b)));
  if (decoded.length !== chapterRows.length) {
    fail(`layout payload coverage: ${decoded.length} payloads for ${chapterRows.length} Chapter Approved layouts`);
  }
  return decoded;
}

function partTemplateId(catalog: RawTemplateCatalog, partIndex: number): string {
  return `bm-${slug(catalog.id)}-part-${slug(catalog.parts[partIndex]!.name)}`;
}

function compositeTemplateId(catalog: RawTemplateCatalog, index: number): string {
  return `bm-${slug(catalog.id)}-composite-${String(index + 1).padStart(2, "0")}`;
}

function projectTemplates(catalog: RawTemplateCatalog): ProjectedTemplate[] {
  const featureTemplates: ProjectedTemplate[] = catalog.parts.map((part, index) => ({
    id: partTemplateId(catalog, index),
    name: `Battlemaster ${part.name}`,
    kind: "feature",
    source: SOURCE,
    footprint: { type: "rectangle", width: part.width, height: part.height },
    game_version: GAME_VERSION,
  }));
  const compositeTemplates: ProjectedTemplate[] = catalog.composites.map((composite, index) => ({
    id: compositeTemplateId(catalog, index),
    name: `Battlemaster ${composite.sizeClass.toUpperCase()} ${String(index + 1).padStart(2, "0")}`,
    kind: "area",
    source: SOURCE,
    footprint: { type: "rectangle", width: composite.width, height: composite.height },
    features: composite.parts.map((placed, partIndex) => {
      const part = catalog.parts[placed.partIndex]!;
      const centre = partCentreYUp(part, placed);
      const feature: ComposedFeature = {
        id: `feature-${partIndex + 1}`,
        template: partTemplateId(catalog, placed.partIndex),
        position: { x: round6(centre.x), y: round6(-centre.y) },
      };
      const rotation = norm360(-placed.rotation);
      if (rotation !== 0) feature.rotation_degrees = rotation;
      if (placed.mirror) feature.mirror = "horizontal";
      return feature;
    }),
    game_version: GAME_VERSION,
  }));
  return [...featureTemplates, ...compositeTemplates];
}

function projectLayouts(catalog: RawTemplateCatalog, rawLayouts: RawLayout[]): ProjectedLayout[] {
  return rawLayouts.map((raw) => {
    const deployment = DEPLOYMENT_KEY_TO_PATTERN[raw.deploymentKey];
    if (!deployment) fail(`${raw.battlemasterId}: unknown deployment key ${raw.deploymentKey}`);
    const pieces = raw.instances.map((instance, index) => {
      const id = `area-${String(index + 1).padStart(2, "0")}`;
      const piece: ProjectedPiece = {
        id,
        name: `Battlemaster area ${String(index + 1).padStart(2, "0")}`,
        piece_type: "area",
        template: compositeTemplateId(catalog, instance.templateIndex),
        position: toBoardFrame(instance.x, instance.y),
      };
      const rotation = norm360(-instance.rotation);
      if (rotation !== 0) piece.rotation_degrees = rotation;
      if (instance.mirror) piece.mirror = "horizontal";
      if (instance.objectiveCode) {
        const role = OBJECTIVE_CODE_TO_ROLE[instance.objectiveCode];
        if (!role) fail(`${raw.battlemasterId}/${id}: unknown objective code ${instance.objectiveCode}`);
        piece.objective_role = role;
        piece.is_objective = true;
        if (instance.objectiveCode === "c1" || instance.objectiveCode === "c2") {
          piece.link_group = "center";
        }
      }
      return piece;
    });
    return {
      id: layoutId(raw),
      name: raw.name,
      source: SOURCE,
      description: `Imported from Battlemaster layout ${raw.battlemasterId}.`,
      mission_matchup_id: matchupId(raw),
      variant: raw.slot,
      deployment_pattern_id: deployment,
      pieces,
      game_version: GAME_VERSION,
    };
  });
}

function placedSourceArea(composite: RawComposite, instance: RawLayoutInstance): Vec2[] {
  const local: Vec2[] = [
    { x: -composite.width / 2, y: -composite.height / 2 },
    { x: composite.width / 2, y: -composite.height / 2 },
    { x: composite.width / 2, y: composite.height / 2 },
    { x: -composite.width / 2, y: composite.height / 2 },
  ];
  return local.map((point) => {
    const mirrored = { x: instance.mirror ? -point.x : point.x, y: point.y };
    const rotated = rotateCcwYUp(mirrored, instance.rotation);
    return toBoardFrame(rotated.x + instance.x, rotated.y + instance.y);
  });
}

function placedSourcePart(
  catalog: RawTemplateCatalog,
  composite: RawComposite,
  partIndex: number,
  instance: RawLayoutInstance,
): Vec2[] {
  const placed = composite.parts[partIndex]!;
  const part = catalog.parts[placed.partIndex]!;
  const local: Vec2[] = [
    { x: 0, y: 0 },
    { x: part.width, y: 0 },
    { x: part.width, y: part.height },
    { x: 0, y: part.height },
  ];
  return local.map((point) => ({ x: placed.mirror ? -point.x : point.x, y: point.y }))
    .map((point) => rotateCcwYUp(point, placed.rotation))
    .map((point) => ({ x: point.x + placed.x, y: point.y + placed.y }))
    .map((point) => ({ x: instance.mirror ? -point.x : point.x, y: point.y }))
    .map((point) => rotateCcwYUp(point, instance.rotation))
    .map((point) => toBoardFrame(point.x + instance.x, point.y + instance.y));
}

function pointSetError(actual: Vec2[], expected: Vec2[]): number {
  const directed = (from: Vec2[], to: Vec2[]): number =>
    Math.max(...from.map((point) => Math.min(...to.map((candidate) => Math.hypot(
      point.x - candidate.x,
      point.y - candidate.y,
    )))));
  return Math.max(directed(actual, expected), directed(expected, actual));
}

function verifyProjection(
  catalog: RawTemplateCatalog,
  rawLayouts: RawLayout[],
  layouts: ProjectedLayout[],
  templates: ProjectedTemplate[],
): Pick<
  BattlemasterProjectionSummary,
  "resolved_pieces" | "worst_area_error_inches" | "worst_feature_error_inches"
> {
  let resolvedPieces = 0;
  let worstArea = 0;
  let worstFeature = 0;
  for (let layoutIndex = 0; layoutIndex < rawLayouts.length; layoutIndex += 1) {
    const raw = rawLayouts[layoutIndex]!;
    const resolved = resolveLayout(layouts[layoutIndex]!, templates);
    resolvedPieces += resolved.length;
    let cursor = 0;
    for (const instance of raw.instances) {
      const composite = catalog.composites[instance.templateIndex]!;
      const areaError = pointSetError(resolved[cursor++]!.vertices, placedSourceArea(composite, instance));
      worstArea = Math.max(worstArea, areaError);
      for (let partIndex = 0; partIndex < composite.parts.length; partIndex += 1) {
        const featureError = pointSetError(
          resolved[cursor++]!.vertices,
          placedSourcePart(catalog, composite, partIndex, instance),
        );
        worstFeature = Math.max(worstFeature, featureError);
      }
    }
    if (cursor !== resolved.length) {
      fail(`${layoutId(raw)}: resolver emitted ${resolved.length} pieces, expected ${cursor}`);
    }
  }
  if (worstArea > ERROR_TOLERANCE || worstFeature > ERROR_TOLERANCE) {
    fail(
      `projected transforms disagree with the baked source: area ${worstArea.toFixed(6)}", ` +
      `feature ${worstFeature.toFixed(6)}" (limit ${ERROR_TOLERANCE}")`,
    );
  }
  return {
    resolved_pieces: resolvedPieces,
    worst_area_error_inches: round6(worstArea),
    worst_feature_error_inches: round6(worstFeature),
  };
}

export function projectBattlemasterCache(
  cache: Record<string, unknown>,
  sourceFile: string,
): BattlemasterProjection {
  const catalog = decodeTemplateCatalog(cache.templateCatalog);
  const rawLayouts = decodeLayouts(cache, catalog.composites.length);
  const templates = projectTemplates(catalog);
  const layouts = projectLayouts(catalog, rawLayouts);
  const verification = verifyProjection(catalog, rawLayouts, layouts, templates);
  const layoutInstances = rawLayouts.reduce((total, layout) => total + layout.instances.length, 0);
  const featureInstances = rawLayouts.reduce(
    (total, layout) => total + layout.instances.reduce(
      (subtotal, instance) => subtotal + catalog.composites[instance.templateIndex]!.parts.length,
      0,
    ),
    0,
  );
  const bakedAt = string(cache.bakedAt, "bakedAt");
  const cacheVersion = integer(cache.version, "version");
  const summary: BattlemasterProjectionSummary = {
    workshop_id: BATTLEMASTER_SPAWNER_WORKSHOP_ID,
    source_file: sourceFile,
    baked_at: bakedAt,
    cache_version: cacheVersion,
    catalog_id: catalog.id,
    layouts: layouts.length,
    layout_instances: layoutInstances,
    feature_instances: featureInstances,
    feature_templates: catalog.parts.length,
    composite_templates: catalog.composites.length,
    ...verification,
  };
  return {
    readonly: true,
    source: {
      kind: "tabletop-simulator-workshop-save",
      workshop_id: BATTLEMASTER_SPAWNER_WORKSHOP_ID,
      workshop_page: BATTLEMASTER_SPAWNER_PAGE,
      source_file: sourceFile,
      public_data_docs: BATTLEMASTER_PUBLIC_DATA_DOCS,
      baked_at: bakedAt,
      cache_version: cacheVersion,
      catalog_id: catalog.id,
    },
    terrain_templates: templates,
    terrain_layouts: layouts,
    summary,
  };
}

async function workshopDownloadUrl(fetchImpl: typeof globalThis.fetch): Promise<string> {
  const body = new URLSearchParams({
    itemcount: "1",
    "publishedfileids[0]": BATTLEMASTER_SPAWNER_WORKSHOP_ID,
  });
  const response = await fetchImpl(WORKSHOP_DETAILS_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) fail(`Steam Workshop metadata request returned HTTP ${response.status}`);
  const payload = record(await response.json(), "Steam Workshop response");
  const responseBody = record(payload.response, "Steam Workshop response.response");
  const details = array(responseBody.publishedfiledetails, "publishedfiledetails");
  if (details.length !== 1) fail(`Steam returned ${details.length} Workshop records`);
  const detail = record(details[0], "publishedfiledetails[0]");
  if (detail.result !== 1) fail(`Steam returned result ${JSON.stringify(detail.result)}`);
  return string(detail.file_url, "publishedfiledetails[0].file_url");
}

export async function projectBattlemaster(
  options: ProjectBattlemasterOptions = {},
): Promise<BattlemasterProjection> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let sourceFile: string;
  let bytes: Uint8Array;
  if (options.inputPath) {
    const path = resolve(options.inputPath);
    sourceFile = basename(path);
    bytes = await readFile(path);
  } else {
    const url = await workshopDownloadUrl(fetchImpl);
    sourceFile = `${BATTLEMASTER_SPAWNER_WORKSHOP_ID}.tts`;
    const response = await fetchImpl(url);
    if (!response.ok) fail(`Workshop save download returned HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  return projectBattlemasterCache(decodeSpawnerSave(bytes), sourceFile);
}
function hasBattlemasterSource(value: unknown): boolean {
  return typeof value === "object" && value !== null && "source" in value && value.source === SOURCE;
}


export function mergeBattlemasterProjection(
  existingLayouts: TerrainLayout[],
  existingTemplates: TerrainTemplate[],
  projection: BattlemasterProjection,
): { terrainLayouts: TerrainLayout[]; terrainTemplates: TerrainTemplate[] } {
  const projectedLayoutIds = new Set(projection.terrain_layouts.map((layout) => layout.id));
  const layouts = existingLayouts.filter(
    (layout) => !hasBattlemasterSource(layout) && !projectedLayoutIds.has(layout.id),
  );
  layouts.push(...projection.terrain_layouts);

  const templates = existingTemplates.filter((template) => !hasBattlemasterSource(template));
  templates.push(...projection.terrain_templates);

  return {
    terrainLayouts: layouts.sort((a, b) => a.id.localeCompare(b.id)),
    terrainTemplates: templates.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export async function applyBattlemasterProjection(
  projection: BattlemasterProjection,
  write: boolean,
): Promise<void> {
  const layoutsPath = resolve(CORE_DIR, "terrain-layouts.json");
  const templatesPath = resolve(CORE_DIR, "terrain-templates.json");
  const merged = mergeBattlemasterProjection(
    readJsonArray<TerrainLayout>(layoutsPath),
    readJsonArray<TerrainTemplate>(templatesPath),
    projection,
  );
  await applyWrites(
    [
      { path: layoutsPath, value: merged.terrainLayouts },
      { path: templatesPath, value: merged.terrainTemplates },
    ],
    { write, label: "battlemaster-layouts" },
  );
}

function usage(): never {
  console.error(
    "Usage: project-battlemaster [--input <WorkshopUpload>] [--summary | --check | --write]\n\n" +
      "Projects Battlemaster's Chapter Approved layouts into 40kdc shapes. " +
      "The default and --summary modes are read-only; --check validates the merged dataset; " +
      "--write atomically imports it.",
  );
  process.exit(2);
}

export async function runProjectBattlemasterCli(args: string[]): Promise<void> {
  let inputPath: string | undefined;
  let summary = false;
  let check = false;
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") {
      inputPath = args[++index];
      if (!inputPath) usage();
    } else if (arg === "--summary") {
      summary = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (Number(summary) + Number(check) + Number(write) > 1) usage();

  const projection = await projectBattlemaster({ inputPath });
  if (check || write) {
    await applyBattlemasterProjection(projection, write);
    if (check) console.log("DRY RUN — no files written. Re-run with --write to apply.");
    console.log(JSON.stringify(projection.summary, null, 2));
    return;
  }
  process.stdout.write(`${JSON.stringify(summary ? projection.summary : projection, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runProjectBattlemasterCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
