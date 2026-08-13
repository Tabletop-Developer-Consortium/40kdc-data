/**
 * Headerless plain-text adapter: the GW 40K app's *exported* list (no
 * `++…++` / `+ FACTION KEYWORD:` summary fence), the NewRecruit "copy as text"
 * dialect, and the markdown-ish `## Section (N pts)` shape hand-authored lists
 * use. All three share one body grammar; they differ only in cosmetic framing,
 * so a single lenient parser covers them.
 *
 * Shape (any of):
 *
 * ```
 * <list name> (1995 Points)            ← title line (consumed, not a unit)
 * World Eaters                         ← faction (bare preamble line)
 * Berzerker Warband                    ← detachment (bare preamble line)
 * Strike Force (2,000 Points)          ← battle-size metadata
 *
 * CHARACTERS                           ← ALL-CAPS role section …
 * ## Battleline (200 pts)              ← … or `##` markdown section …
 * Epic Hero:                           ← … or `Title:` colon section
 *
 * Khârn the Betrayer (100 Points)      ← unit header: Name (N pts|Points)
 *   • Warlord                          ← annotation
 *   • 1x Gorechild                     ← Nx wargear (single-model unit)
 *   • Enhancements: Berzerker Glaive   ← enhancement
 * Khorne Berzerkers (180 Points)
 *   • 9x Khorne Berzerker              ← model group (has ◦ children) …
 *      ◦ 8x Bolt pistol                ← … children are squad-wide wargear
 *   • 4x Intercessor: Bolt rifle       ← model group (colon wargear, no children)
 *
 * Fire Dragons (120 points)            ← GW app v2.0.5 "Attached Units" nesting
 * • Attached as: Bodyguard             ← attachment annotation (skipped)
 *   • 4x Fire Dragon                   ← model group (deeper • child) …
 *     • 4x Close combat weapon         ← … first weapon is bulleted …
 *       4x Dragon fusion gun           ← … the rest are unbulleted continuations
 * ```
 *
 * **Model vs wargear** (the crux), unified across dialects: a model group is a
 * bulleted entry, at the shallowest model indent, that is followed by a *deeper
 * bulleted* line (its squad-wide wargear); its `Nx` count (default 1) adds to
 * the model count. Keying on the child being *bulleted* keeps a lone bulleted
 * weapon trailed by unbulleted continuation lines (a Fire Prism's `Prism
 * cannon`) as wargear, not a model. A bullet with a `: wargear` colon is also a
 * model group. Everything else is wargear — a `Nx`/bare item, or the GW app's
 * unbulleted continuation lines (v2.0.5 bullets only the *first* weapon under a
 * model and emits the rest unbulleted, one indent deeper) — or an annotation
 * (`Warlord`, `… Character`, `Enhancements: …`, `Attached as: …`).
 *
 * **Faction / detachment**: the GW export lists them as bare lines between the
 * title and the first section (`World Eaters` / `Berzerker Warband`). The first
 * two such preamble lines are captured so `resolve` can scope to them.
 *
 * **Disjointness**: this adapter is the fallback for bullet-bearing text that
 * the framed adapters reject — it declines input carrying the GW
 * `+ FACTION KEYWORD:` fence (→ {@link gwAdapter}), the NewRecruit
 * `# ++ Army Roster ++` header (→ newrecruit-simple), or WTC `N with` body
 * lines, and requires at least one `•`/`◦` bullet.
 *
 * @packageDocumentation
 */
import type { FormatAdapter } from "./adapter.js";
import type { ParsedRoster, ParsedUnit, ParsedWargear } from "./types.js";
import { inferBattleSizeRaw } from "./newrecruit-text.js";

const CHARACTERS_SECTION = "CHARACTERS";
const ALLIED_SECTION = "ALLIED UNITS";
const CHARACTER_SUFFIX = " Character";
const WARLORD_MARKER = "Warlord";

/** Title / unit header: `Name (N pts|Points)` with an optional trailing comment
 * (the GW export sometimes appends TO notes). Points may carry thousands
 * commas. Case-insensitive `pts`/`points`. */
const RE_PTS_LINE = /^(.+?)\s*\(\s*([\d,]+)\s*(?:pts?|points?)\s*\).*$/i;
/** `## Section [ (N pts) ]` markdown header. */
const RE_MD_SECTION = /^#{1,6}\s*(.+?)\s*$/;
/** ALL-CAPS role section (`CHARACTERS`, `OTHER DATASHEETS`, …). */
const RE_CAPS_SECTION = /^[A-Z][A-Z0-9 \-/&]+$/;
/** `Title:` colon section (`Epic Hero:`, `Battleline:`). */
const RE_COLON_SECTION = /^([A-Za-z][\w /&-]*):\s*$/;
/** Bullet line: leading indent, a `•` or `◦` marker, then the body. */
const RE_BULLET = /^([\t ]*)[•◦]\s*(.+?)\s*$/u;
const RE_NX_PREFIX = /^(\d+)x\s+(.+)$/i;
/** Inline enhancement annotation: `Name (+N pts)`. */
const RE_ENHANCEMENT_ANNOT = /^(.+?)\s*\(\+\s*(\d+)\s*pts?\s*\)\s*$/i;
/** `Enhancements: X` / `E: X` enhancement bullet. */
const RE_ENHANCEMENT_LABEL = /^(?:e|enh|enhancement|enhancements)\s*:\s*(.+)$/i;
/** Attachment relationship annotations emitted by GW-family exports. */
const RE_ATTACHMENT = /^(attached\s+as|leader|leading)\s*:\s*(.+)$/i;
const RE_WITH_LINE = /^[\t ]*\d+\s+with\b/m;
const RE_BULLET_ANYWHERE = /^[\t ]*[•◦]/mu;
/** ListForge-text first line: `<name> - <faction> - <detachment> (N Points)`.
 * Used only to *decline* — that framed header belongs to `listForgeTextAdapter`,
 * which runs ahead of us; declining keeps the matchers mutually exclusive. */
const RE_LISTFORGE_FIRST_LINE = /^(.+)\s\(\s*\d+\s*Points?\s*\)\s*$/i;

/** Battle-size labels that look like unit headers (`Strike Force (2,000 Points)`)
 * but are army metadata, not datasheets. */
const BATTLE_SIZE_NAMES = new Set([
  "combat patrol",
  "incursion",
  "strike force",
  "onslaught",
]);

function parsePts(raw: string): number | null {
  const n = Number.parseInt(raw.replace(/,/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

/** A line of only `+` characters — the BCP summary block's fence. */
const RE_PLUS_FENCE = /^\++$/;
/** A line inside that block identifying it as BCP's (not GW's own `+ …` fence). */
const RE_BCP_SUMMARY_MARKER = /^\s*(?:Player Name|Team Name|Factions Used|Army Points)\s*:/im;

/**
 * BCP prepends a `++…++`-fenced summary block (`Player Name:` / `Factions Used:`
 * / `Army Points: N` / …) to text-type lists. It is BCP metadata, not part of the
 * pasted roster, and it derails the body grammar: the fence line gets consumed as
 * the roster title, so the *real* title line (`House Rosecairn (1995 points)`)
 * becomes a phantom unit and its points double the computed total. Strip the
 * leading block when present. Only a block whose fence pair wraps a BCP marker is
 * removed, so a framed GW export's own `+ FACTION KEYWORD:` fence is left intact.
 */
function stripBcpSummary(text: string): string {
  const lines = text.split(/\r?\n/);
  let open = 0;
  while (open < lines.length && lines[open].trim() === "") open += 1;
  if (open >= lines.length || !RE_PLUS_FENCE.test(lines[open].trim())) return text;
  let close = -1;
  for (let j = open + 1; j < lines.length; j += 1) {
    if (RE_PLUS_FENCE.test(lines[j].trim())) {
      close = j;
      break;
    }
  }
  if (close === -1) return text;
  const block = lines.slice(open + 1, close).join("\n");
  if (!RE_BCP_SUMMARY_MARKER.test(block)) return text;
  return lines.slice(close + 1).join("\n");
}

/** Accept bullet-bearing plain text that no framed adapter claims. */
function headerlessText(decoded: unknown): string | null {
  if (typeof decoded !== "string") return null;
  const text = stripBcpSummary(decoded);
  if (!RE_BULLET_ANYWHERE.test(text)) return null; // need a bullet
  if (text.includes("+ FACTION KEYWORD:")) return null; // framed GW → gwAdapter
  if (RE_WITH_LINE.test(text)) return null; // WTC-full
  const lines = text.split(/\r?\n/);
  // ListForge-text's `name - faction - detachment (N Points)` header → defer to
  // listForgeTextAdapter (registered ahead of us). Mirrors its own matcher so
  // the two stay disjoint, per the importer's single-match invariant.
  const firstNonBlank = lines.find((l) => l.trim().length > 0);
  const lf = firstNonBlank && RE_LISTFORGE_FIRST_LINE.exec(firstNonBlank.trim());
  if (lf && lf[1].split(" - ").length >= 3) return null;
  // NewRecruit `# ++ Army Roster ++` → newrecruit-simple.
  if (
    lines.some((l) => {
      const t = l.trim();
      return t.startsWith("# ++") && t.includes("Army Roster");
    })
  ) {
    return null;
  }
  // Require a `Name (N pts|Points)` line somewhere — the unit/title signature.
  return lines.some((l) => RE_PTS_LINE.test(l.trim())) ? text : null;
}

interface Bullet {
  indent: number;
  count: number | null;
  /** Model/wargear name (after any `Nx` and before any `: wargear`). */
  name: string;
  /** Comma-separated wargear listed after a `:` on a model bullet. */
  colon_wargear: string | null;
  /** True for `Warlord` / `… Character` / `Enhancements:` / `Attached as:`
   * annotations. */
  is_annotation: boolean;
  /** `[name, points]` when this bullet declares an enhancement. */
  enhancement: [string, number | null] | null;
  /** True when the source line carried a `•`/`◦` marker; false for the GW app's
   * unbulleted continuation wargear lines. Model detection keys on this: a model
   * is an entry followed by a *deeper bulleted* line, so a lone bulleted weapon
   * with plain continuations (Fire Prism) is not mistaken for a model. */
  bulleted: boolean;
  /** True for an attachment relationship annotation — never a model or wargear,
   * even though it sits (bulleted) shallower than the models. */
  is_attachment: boolean;
  /** An `Attached as: … (Character)` annotation flags the unit as a character. */
  sets_character: boolean;
}

interface UnitAcc {
  raw_name: string;
  displayed_pts: number | null;
  is_character_section: boolean;
  bullets: Bullet[];
}

function parseBullet(indent: number, body: string, bulleted: boolean): Bullet {
  const base = { indent, bulleted, is_attachment: false, sets_character: false } as const;

  // Attachment relationship metadata is never a model or wargear. Catch it
  // before the generic colon split: otherwise `Leader: Character Name` becomes
  // an inline model and inflates the bodyguard's model count by one.
  const attachment = RE_ATTACHMENT.exec(body);
  if (attachment) {
    return {
      ...base,
      count: null,
      name: "",
      colon_wargear: null,
      is_annotation: true,
      enhancement: null,
      is_attachment: true,
      sets_character:
        /^attached\s+as$/i.test(attachment[1]) &&
        /\(\s*Character\s*\)/i.test(attachment[2]),
    };
  }

  // Enhancement label first — `Enhancements: X` must not read as a model.
  const label = RE_ENHANCEMENT_LABEL.exec(body);
  if (label) {
    return {
      ...base,
      count: null,
      name: "",
      colon_wargear: null,
      is_annotation: true,
      enhancement: [label[1].trim(), null],
    };
  }

  const nx = RE_NX_PREFIX.exec(body);
  const count = nx ? Number.parseInt(nx[1], 10) : null;
  const rest = (nx ? nx[2] : body).trim();

  // `Name (+N pts)` enhancement annotation.
  const annot = RE_ENHANCEMENT_ANNOT.exec(rest);
  if (annot) {
    const pts = Number.parseInt(annot[2], 10);
    return {
      ...base,
      count,
      name: rest,
      colon_wargear: null,
      is_annotation: true,
      enhancement: [annot[1].trim(), Number.isNaN(pts) ? null : pts],
    };
  }

  // `ModelType: w1, w2` — a model bullet with inline wargear.
  const idx = rest.indexOf(":");
  if (idx >= 0) {
    const wargear = rest.slice(idx + 1).trim();
    return {
      ...base,
      count,
      name: rest.slice(0, idx).trim(),
      colon_wargear: wargear.length > 0 ? wargear : null,
      is_annotation: false,
      enhancement: null,
    };
  }

  // Bare token: annotation iff it has no count (Warlord / Character / wargear).
  return {
    ...base,
    count,
    name: rest,
    colon_wargear: null,
    is_annotation: count === null,
    enhancement: null,
  };
}

function finishUnit(acc: UnitAcc): ParsedUnit {
  // Models live at the shallowest *bulleted* indent that isn't an annotation,
  // enhancement, or colon-wargear line. The GW v2.0.5 export prefixes each unit
  // with an `Attached as:` bullet shallower than the models, so the old
  // "min of all indents" would misplace the model level — filter those out.
  const modelEligible = acc.bullets.filter(
    (b) =>
      b.bulleted &&
      !b.is_attachment &&
      !b.enhancement &&
      b.colon_wargear === null,
  );
  const modelIndent = modelEligible.length
    ? Math.min(...modelEligible.map((b) => b.indent))
    : 0;

  // A model group: a bulleted entry at the model indent that is followed by a
  // *deeper bulleted* line (its squad-wide wargear). Keying on the child being
  // bulleted keeps a lone bulleted weapon trailed by plain continuation lines
  // (Fire Prism's Prism cannon) as wargear, not a model. A count-less model
  // name (`• Bloodreaper` with children) still counts as one model (`?? 1`).
  const isModelGroup = (b: Bullet, next: Bullet | undefined): boolean =>
    b.bulleted &&
    b.colon_wargear === null &&
    !b.enhancement &&
    !b.is_attachment &&
    b.indent === modelIndent &&
    next !== undefined &&
    next.bulleted &&
    next.indent > b.indent;

  const wargear = new Map<string, number>();
  const addWargear = (raw_name: string, count: number): void => {
    const name = raw_name.trim();
    if (!name) return;
    wargear.set(name, (wargear.get(name) ?? 0) + count);
  };

  let model_count = 0;
  let is_warlord = false;
  let is_character = acc.is_character_section;
  let enhancement_raw_name: string | null = null;
  let enhancement_points: number | null = null;

  for (let i = 0; i < acc.bullets.length; i += 1) {
    const b = acc.bullets[i];

    // `Attached as: …` carries no model or gear; a `(Character)` role flags the
    // unit as a character. Skip before model detection — it sits shallower than
    // the models and would otherwise read as a model group.
    if (b.is_attachment) {
      if (b.sets_character) is_character = true;
      continue;
    }

    // Enhancement annotation (`Enhancements: X` or `X (+N pts)`).
    if (b.enhancement) {
      if (enhancement_raw_name === null) {
        enhancement_raw_name = b.enhancement[0];
        enhancement_points = b.enhancement[1];
      }
      continue;
    }

    // Model with inline `: wargear` (the `##`/fixture dialect).
    if (b.colon_wargear !== null) {
      const n = b.count ?? 1;
      model_count += n;
      for (const item of b.colon_wargear.split(",").map((s) => s.trim())) {
        if (item) addWargear(item, n);
      }
      continue;
    }

    // Model group: counted bullet at the model indent with a deeper bulleted child.
    if (isModelGroup(b, acc.bullets[i + 1])) {
      model_count += b.count ?? 1;
      continue;
    }

    // Annotation (no count): Warlord / Character flags, else bare wargear.
    if (b.is_annotation) {
      const leftover: string[] = [];
      for (const token of b.name.split(",").map((t) => t.trim())) {
        if (!token) continue;
        if (token === WARLORD_MARKER) {
          is_warlord = true;
        } else if (token.endsWith(CHARACTER_SUFFIX)) {
          is_character = true;
        } else {
          leftover.push(token);
        }
      }
      for (const token of leftover) addWargear(token, 1);
      continue;
    }

    // Everything else is wargear — a bulleted weapon under a model or an
    // unbulleted continuation line, at any depth.
    addWargear(b.name, b.count ?? 1);
  }

  if (model_count === 0) model_count = 1;

  let points = acc.displayed_pts;
  if (acc.displayed_pts !== null && enhancement_points !== null) {
    points = Math.max(0, acc.displayed_pts - enhancement_points);
  }

  return {
    raw_name: acc.raw_name,
    is_character,
    model_count,
    points,
    is_warlord,
    enhancement_raw_name,
    enhancement_points,
    wargear: [...wargear].map(
      ([raw_name, count]): ParsedWargear => ({ raw_name, count }),
    ),
  };
}

function isBattleSize(name: string): boolean {
  return BATTLE_SIZE_NAMES.has(name.trim().toLowerCase());
}

export const gwHeaderlessAdapter: FormatAdapter = {
  // Provenance: a GW-family plain-text export. Reuses the `gw` id so no schema
  // churn is needed for a new label (mirrors the Rust adapter).
  id: "gw",

  matches(decoded: unknown): boolean {
    return headerlessText(decoded) !== null;
  },

  parse(decoded: unknown): ParsedRoster {
    const text = headerlessText(decoded);
    if (text === null) {
      throw new Error("gw-headerless: not a headerless plain-text list");
    }

    let name = "Imported roster";
    let declared_limit: number | null = null;
    let battle_size_raw: string | null = null;
    const units: ParsedUnit[] = [];
    let current: UnitAcc | null = null;
    let section: string | null = null;
    let allied = 0;
    let consumed_title = false;
    // The GW app export lists faction then detachment as bare lines between the
    // title and the first section. Capture the first two so `resolve` can scope
    // to them; later bare lines (stray notes) are ignored.
    let faction_raw_name: string | null = null;
    const detachment_raw_names: string[] = [];

    const flush = (): void => {
      if (current) {
        units.push(finishUnit(current));
        current = null;
      }
    };

    for (const rawLine of text.split("\n")) {
      const raw = rawLine.replace(/\r+$/, "");
      const line = raw.trim();
      if (!line) continue;

      // Bullets attach to the open unit.
      const bullet = RE_BULLET.exec(raw);
      if (bullet) {
        if (current) {
          current.bullets.push(parseBullet(bullet[1].length, bullet[2], true));
        }
        continue;
      }

      // GW export footer.
      if (line.startsWith("Exported with")) continue;

      // The GW app bullets only the first wargear line under a model and emits
      // the rest unbulleted, one indent deeper (`      4x Shuriken pistol`).
      // Capture those `Nx …` continuation lines as the open unit's wargear at
      // their real indent so `finishUnit` can place them. A unit header also
      // lacks a bullet but carries a `(N pts)` parenthetical, so it is excluded
      // here and handled just below.
      const nx = RE_NX_PREFIX.exec(line);
      if (current && nx && !RE_PTS_LINE.test(line)) {
        const indent = raw.length - raw.trimStart().length;
        current.bullets.push(parseBullet(indent, line, false));
        continue;
      }

      // `## Section` markdown header (strip an optional `(N pts)` tail).
      const md = RE_MD_SECTION.exec(line);
      if (md) {
        flush();
        const pts = RE_PTS_LINE.exec(md[1]);
        section = pts ? pts[1].trim() : md[1].trim();
        continue;
      }

      // First `Name (N pts|Points)` line is the roster title, not a unit.
      const pts = RE_PTS_LINE.exec(line);
      if (pts) {
        const header_name = pts[1].trim();
        const points = parsePts(pts[2]);
        if (!consumed_title && current === null && units.length === 0) {
          consumed_title = true;
          name = header_name;
          declared_limit = points;
          continue;
        }
        // Some event exports prepend participant/team/faction lines without a
        // fence. Their actual high-point roster title arrives after two bare
        // preamble fields; recover it instead of emitting a phantom unit.
        if (
          declared_limit === null &&
          current === null &&
          units.length === 0 &&
          detachment_raw_names.length === 1 &&
          (points ?? 0) >= 1000
        ) {
          name = header_name;
          declared_limit = points;
          faction_raw_name = detachment_raw_names[0];
          detachment_raw_names.length = 0;
          continue;
        }
        // Battle-size metadata (`Strike Force (2,000 Points)`).
        if (isBattleSize(header_name)) {
          battle_size_raw = line;
          if (declared_limit === null) declared_limit = points;
          continue;
        }
        // A real unit header.
        flush();
        const inChars = section?.toLowerCase() === CHARACTERS_SECTION.toLowerCase();
        if (section === ALLIED_SECTION) allied += 1;
        current = {
          raw_name: header_name,
          displayed_pts: points,
          is_character_section: inChars,
          bullets: [],
        };
        continue;
      }

      // Section headers without points (ALL-CAPS role, `Title:` colon).
      if (RE_CAPS_SECTION.test(line) || RE_COLON_SECTION.test(line)) {
        flush();
        section = line.replace(/:\s*$/, "").trim();
        continue;
      }

      // Anything else (faction/detachment preamble, stray notes).
      if (!consumed_title && current === null && units.length === 0) {
        // Very first content line with no `(N pts)` title → use as name.
        consumed_title = true;
        name = line;
      } else if (current === null && units.length === 0) {
        // Preamble after the title, before the first unit: faction then
        // detachment. Names are resolved (and warned on miss) downstream.
        // The GW app (v2.0.4+) suffixes the detachment line with its cost —
        // "Awakened Dynasty (3 Detachment Points)" — which is presentation,
        // not part of the name; strip it so resolution sees the bare name.
        if (faction_raw_name === null) {
          faction_raw_name = line;
        } else if (detachment_raw_names.length === 0) {
          detachment_raw_names.push(line.replace(/\s*\(\d+\s+Detachment Points?\)\s*$/i, ""));
        }
      }
    }
    flush();

    let total_computed = 0;
    for (const u of units) {
      total_computed += (u.points ?? 0) + (u.enhancement_points ?? 0);
    }

    return {
      name,
      generated_by: null,
      faction_raw_name,
      detachment_raw_names,
      battle_size_raw: battle_size_raw ?? inferBattleSizeRaw(declared_limit),
      declared_limit,
      total_reported: null,
      total_computed,
      units,
      multi_force: allied > 0,
    };
  },
};

// Internals re-exported for unit tests.
export const _internals = {
  headerlessText,
  parseBullet,
};
