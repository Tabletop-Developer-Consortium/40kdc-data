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
import type {
  ParsedLoadoutGroup,
  ParsedRoster,
  ParsedUnit,
  ParsedWargear,
} from "./types.js";
import {
  classifyWargearList,
  inferBattleSizeRaw,
  splitWargearList,
} from "./newrecruit-text.js";

const CHARACTERS_SECTION = "CHARACTERS";
const ALLIED_SECTION = "ALLIED UNITS";
const CHARACTER_SUFFIX = " Character";
const WARLORD_MARKER = "Warlord";

/** Title / unit header: `Name (N pts|Points)` with an optional trailing comment.
 * Event exports use commas, periods, apostrophes, ordinary spaces, NBSP, and
 * narrow NBSP as thousands separators. */
const RE_PTS_LINE =
  /^(.+?)\s*\(\s*([\d,.'’\u00a0\u202f ]+)\s*(?:pts?|points?)\s*\).*$/i;
/** `## Section [ (N pts) ]` markdown header. */
const RE_MD_SECTION = /^#{1,6}\s*(.+?)\s*$/;
/** ALL-CAPS role section (`CHARACTERS`, `OTHER DATASHEETS`, …). */
const RE_CAPS_SECTION = /^[A-Z][A-Z0-9 \-/&]+$/;
/** `Title:` colon section (`Epic Hero:`, `Battleline:`). */
const RE_COLON_SECTION = /^([A-Za-z][\w /&-]*):\s*$/;
/** Bullet line: leading indent, a `•` or `◦` marker, then the body. */
const RE_BULLET = /^([\t \u00a0]*)([•◦*])\s*(.+?)\s*$/u;
const RE_NX_PREFIX = /^(\d+)[x×]\s+(.+)$/iu;
const RE_MODEL_WITH_WARGEAR = /^(\d+)(?:[x×]\s+|\s+)(.+?)\s+with\s+(.+)$/iu;
/** A title-less total line used by some event submissions: `(2000 points)`. */
const RE_BARE_POINTS_LINE =
  /^\(?\s*([\d,.'’\u00a0\u202f ]+)\s*(?:pts?|points?)\s*\)?$/i;
/** Inline enhancement annotation: `Name (+N pts)` or `Name [+N points]`. */
const RE_ENHANCEMENT_ANNOT =
  /^(.+?)\s*(?:\(\+\s*(\d+)\s*pts?\s*\)|\[\+\s*(\d+)\s*(?:pts?|points?)\s*\])\s*$/i;
/** `Enhancements: X` / `E: X` and localized equivalents. */
const RE_ENHANCEMENT_LABEL =
  /^(?:e|enh|enhancement|enhancements|verbesserung|verbesserungen)\s*:\s*(.+)$/i;
/** Attachment relationship annotations emitted by GW-family exports. */
const RE_ATTACHMENT = /^(attached\s+as|leader|leading)\s*:\s*(.+)$/i;
const RE_WITH_LINE = /^[\t ]*\d+\s+with\b/m;
const RE_BULLET_ANYWHERE = /^[\t \u00a0]*[•◦*]/mu;
/** ListForge-text first line: `<name> - <faction> - <detachment> (N Points)`.
 * Used only to *decline* — that framed header belongs to `listForgeTextAdapter`,
 * which runs ahead of us; declining keeps the matchers mutually exclusive. */
const RE_LISTFORGE_FIRST_LINE =
  /^(.+)\s\(\s*[\d,.'’\u00a0\u202f ]+\s*Points?\s*\)\s*$/i;
const RE_CHARACTER_ANNOTATION =
  /^(?:.+\s+keywords?\s*:\s*character|subterranean\s+assault\s+character)$/i;
const RE_COLON_ANNOTATION =
  /^(?:.+\s+keywords?|mark of chaos|daemonic allegiance)\s*:/i;
const RE_KEYWORD_ANNOTATION =
  /^This Datasheet also has the (.+?) keyword$/i;

/** Battle-size labels that look like unit headers (`Strike Force (2,000 Points)`)
 * but are army metadata, not datasheets. */
const BATTLE_SIZE_NAMES = new Set([
  "combat patrol",
  "incursion",
  "strike force",
  "onslaught",
  "strikeforce",
]);
const FORCE_DISPOSITION_NAMES = new Set([
  "disruption",
  "priority assets",
  "purge the foe",
  "reconnaissance",
  "recon",
  "take and hold",
]);
const GENERIC_FACTION_BREADCRUMBS = new Set([
  "chaos",
  "imperium",
  "space marines",
  "xenos",
]);
const RE_BODY_SECTION =
  /^(?:CHARACTERS|BATTLELINE|DEDICATED TRANSPORTS|OTHER DATASHEETS|ALLIED UNITS|FORTIFICATIONS)$/i;
const RE_ATTACHED_SECTION = /^attached units?(?:\s+\d+)?$/i;

function parsePts(raw: string): number | null {
  const n = Number.parseInt(raw.replace(/\D/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

/** A line of only `+` characters — the BCP summary block's fence. */
const RE_PLUS_FENCE = /^\++$/;
/** A line inside that block identifying it as BCP's (not GW's own `+ …` fence). */
const RE_BCP_SUMMARY_MARKER =
  /^\s*\+?\s*(?:Player Name|Team Name|Factions? Used|Army Points)\s*:/im;
const RE_BCP_WARLORD = /^\s*\+?\s*WARLORD:\s*(.+?)\s*$/im;
const RE_EMBEDDED_APP_BATTLE_SIZE =
  /^\s*(?:Combat Patrol|Incursion|Strike Force|Onslaught)\s*\(\s*[\d.,]+\s*Points?\s*\)\s*$/im;

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
  const open = lines.findIndex((line) => RE_PLUS_FENCE.test(line.trim()));
  if (open < 0) return text;
  let close = -1;
  for (let j = open + 1; j < lines.length; j += 1) {
    if (RE_PLUS_FENCE.test(lines[j].trim())) {
      close = j;
      break;
    }
  }
  if (close === -1) return text;
  const block = lines.slice(open + 1, close).join("\n");
  const remainder = lines.slice(close + 1).join("\n");
  if (
    !RE_BCP_SUMMARY_MARKER.test(block) &&
    !RE_EMBEDDED_APP_BATTLE_SIZE.test(remainder)
  ) {
    return text;
  }
  return [...lines.slice(0, open), ...lines.slice(close + 1)].join("\n");
}
/**
 * Recover line breaks stripped by spreadsheet/copy-paste pipelines. Dense event
 * submissions can collapse metadata, unit headers, bullets, and consecutive
 * `Nx` wargear entries onto one physical line; the ordinary parser still owns
 * the resulting logical lines.
 */
function expandDenseLines(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const bulletParts = rawLine.split(/(?<=\S)[\t \u00a0]+(?=[•◦]\s*)/u);
    for (const bulletPart of bulletParts) {
      const attachedHeadings =
        /^(Attached Units)\s+(Attached Unit\s+\d+)$/i.exec(bulletPart.trim());
      if (attachedHeadings) {
        out.push(attachedHeadings[1], attachedHeadings[2]);
        continue;
      }
      const metadata = /^(.+?\(\s*\d+\s+Detachment Points?\s*\))\s+(Disruption|Priority Assets|Purge the Foe|Reconnaissance|Take and Hold)\s+((?:Combat Patrol|Incursion|Strike Force|Onslaught)\s*\(.+\))$/i.exec(
        bulletPart.trim(),
      );
      if (metadata) {
        out.push(metadata[1], metadata[2], metadata[3]);
        continue;
      }
      const countParts = bulletPart.split(
        /(?<=[^\s•◦*])[\t \u00a0]+(?=\d+[x×]\s)/u,
      );
      for (let part of countParts) {
        const leadingBullet = /^[•◦]\s*(.+)$/u.exec(part.trim());
        if (leadingBullet && RE_PTS_LINE.test(leadingBullet[1])) {
          part = leadingBullet[1];
        }
        out.push(part);
      }
    }
  }
  return out;
}

/** Accept bullet-bearing plain text that no framed adapter claims. */
function headerlessText(decoded: unknown): string | null {
  if (typeof decoded !== "string") return null;
  if (
    decoded.includes("+ FACTION KEYWORD:") &&
    decoded.includes("+ NUMBER OF UNITS:") &&
    !RE_EMBEDDED_APP_BATTLE_SIZE.test(decoded)
  ) {
    return null;
  }
  const text = stripBcpSummary(decoded);
  if (!RE_BULLET_ANYWHERE.test(text)) return null; // need a bullet
  if (text.includes("+ FACTION KEYWORD:") && !RE_EMBEDDED_APP_BATTLE_SIZE.test(text)) {
    return null;
  }
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
  /** Keyword explicitly selected or granted by this annotation. */
  keyword_override: string | null;
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
  /** Explicit role from `Attached as: …`, when present. */
  attachment_role: "leader" | "support" | "bodyguard" | null;
}

interface UnitAcc {
  raw_name: string;
  displayed_pts: number | null;
  is_character_section: boolean;
  bullets: Bullet[];
  attachment_group: number | null;
  attachment_role: "leader" | "support" | "bodyguard" | null;
}

function parseBullet(indent: number, body: string, bulleted: boolean): Bullet {
  const base = {
    indent,
    bulleted,
    is_attachment: false,
    sets_character: false,
    keyword_override: null,
    attachment_role: null,
  } as const;

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
      attachment_role: /^attached\s+as$/i.test(attachment[1])
        ? (/^(leader|support|bodyguard)\b/i.exec(attachment[2])?.[1].toLowerCase() as
            | "leader"
            | "support"
            | "bodyguard"
            | undefined) ?? null
        : null,
    };
  }
  if (RE_CHARACTER_ANNOTATION.test(body.trim())) {
    return {
      ...base,
      count: null,
      name: "",
      colon_wargear: null,
      is_annotation: true,
      enhancement: null,
      keyword_override: "Character",
      sets_character: true,
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
  let count = nx ? Number.parseInt(nx[1], 10) : null;
  let rest = (nx ? nx[2] : body).trim();

  // `Name (+N pts)` enhancement annotation.
  const annot = RE_ENHANCEMENT_ANNOT.exec(rest);
  if (annot) {
    const pts = Number.parseInt(annot[2] ?? annot[3], 10);
    return {
      ...base,
      count,
      name: rest,
      colon_wargear: null,
      is_annotation: true,
      enhancement: [annot[1].trim(), Number.isNaN(pts) ? null : pts],
    };
  }
  // WTC submissions sometimes use NewRecruit's `N Model with w1, w2`
  // grouping inside an otherwise GW-shaped list. Lower it to the same model
  // plus inline-wargear representation as the colon dialect.
  const modelWithWargear = RE_MODEL_WITH_WARGEAR.exec(rest);
  if (modelWithWargear) {
    return {
      ...base,
      count: Number.parseInt(modelWithWargear[1], 10),
      name: modelWithWargear[2].trim(),
      colon_wargear: modelWithWargear[3].includes(",")
        ? modelWithWargear[3].replace(/\s+and\s+(?=[^,]+$)/i, ", ").trim()
        : modelWithWargear[3].trim(),
      is_annotation: false,
      enhancement: null,
    };
  }
  if (count === null) {
    const plainCount = /^(\d+)\s+(.+)$/.exec(rest);
    if (plainCount) {
      count = Number.parseInt(plainCount[1], 10);
      rest = plainCount[2].trim();
    }
  }
  const explicitKeyword = RE_KEYWORD_ANNOTATION.exec(rest);
  if (RE_CHARACTER_ANNOTATION.test(rest) || explicitKeyword) {
    return {
      ...base,
      count: null,
      name: "",
      colon_wargear: null,
      is_annotation: true,
      enhancement: null,
      sets_character: RE_CHARACTER_ANNOTATION.test(rest),
      keyword_override: explicitKeyword?.[1].trim() ?? "Character",
    };
  }

  if (RE_COLON_ANNOTATION.test(rest)) {
    const keyword = rest.slice(rest.indexOf(":") + 1).trim();
    return {
      ...base,
      count: null,
      name: "",
      colon_wargear: null,
      is_annotation: true,
      enhancement: null,
      keyword_override: keyword || null,
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
      !b.sets_character &&
      !b.enhancement &&
      b.name !== WARLORD_MARKER &&
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
    !b.sets_character &&
    b.name !== WARLORD_MARKER &&
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
  const keyword_overrides = new Set<string>();
  const candidateGroups: ParsedLoadoutGroup[] = [];

  for (let i = 0; i < acc.bullets.length; i += 1) {
    const b = acc.bullets[i];

    if (b.keyword_override) keyword_overrides.add(b.keyword_override);
    // Character-promoting source annotations carry no model or gear. Attachment
    // metadata is likewise skipped before model detection.
    if (b.sets_character) {
      is_character = true;
      continue;
    }
    if (b.is_attachment) continue;

    // Enhancement annotation (`Enhancements: X` or `X (+N pts)`).
    if (b.enhancement) {
      if (enhancement_raw_name === null) {
        enhancement_raw_name = b.enhancement[0];
        enhancement_points = b.enhancement[1];
      }
      continue;
    }

    // Model with inline wargear (`Model: w1, w2` or `N Model with w1, w2`).
    if (b.colon_wargear !== null) {
      const n = b.count ?? 1;
      model_count += n;
      const classified = classifyWargearList(splitWargearList(b.colon_wargear));
      for (const item of classified.wargear) {
        addWargear(item.raw_name, item.count * n);
      }
      candidateGroups.push({
        model_name: b.name,
        count: n,
        wargear: classified.wargear,
      });
      continue;
    }

    // Model group: counted bullet at the model indent with a deeper bulleted child.
    if (isModelGroup(b, acc.bullets[i + 1])) {
      const n = b.count ?? 1;
      model_count += n;
      const groupWargear: ParsedWargear[] = [];
      let exact = true;
      for (let j = i + 1; j < acc.bullets.length; j += 1) {
        const child = acc.bullets[j];
        if (child.indent <= b.indent) break;
        if (
          child.is_attachment ||
          child.sets_character ||
          child.enhancement ||
          child.is_annotation ||
          child.colon_wargear !== null
        ) {
          exact = false;
          continue;
        }
        const total = child.count ?? 1;
        if (total % n !== 0) {
          exact = false;
          continue;
        }
        groupWargear.push({ raw_name: child.name, count: total / n });
      }
      if (exact && groupWargear.length > 0) {
        candidateGroups.push({ model_name: b.name, count: n, wargear: groupWargear });
      }
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

  const groupedCounts = new Map<string, number>();
  for (const group of candidateGroups) {
    for (const item of group.wargear) {
      groupedCounts.set(
        item.raw_name,
        (groupedCounts.get(item.raw_name) ?? 0) + item.count * group.count,
      );
    }
  }
  const exactGroups =
    candidateGroups.reduce((sum, group) => sum + group.count, 0) === model_count &&
    groupedCounts.size === wargear.size &&
    [...wargear].every(([name, count]) => groupedCounts.get(name) === count);

  return {
    raw_name: acc.raw_name,
    is_character,
    model_count,
    points,
    is_warlord,
    enhancement_raw_name,
    ...(keyword_overrides.size ? { keyword_overrides: [...keyword_overrides] } : {}),
    enhancement_points,
    wargear: [...wargear].map(
      ([raw_name, count]): ParsedWargear => ({ raw_name, count }),
    ),
    ...(exactGroups ? { loadout_groups: candidateGroups } : {}),
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

    const summaryWarlord =
      typeof decoded === "string" ? RE_BCP_WARLORD.exec(decoded)?.[1]?.trim() ?? null : null;
    let name = "Imported roster";
    let declared_limit: number | null = null;
    let total_reported: number | null = null;
    let battle_size_raw: string | null = null;
    const units: ParsedUnit[] = [];
    let current: UnitAcc | null = null;
    let section: string | null = null;
    let allied = 0;
    let consumed_title = false;
    let preamble_open = true;
    const preamble_lines: string[] = [];
    let faction_raw_name: string | null = null;
    const detachment_raw_names: string[] = [];
    let force_disposition_raw_name: string | null = null;
    const attachmentMembers: {
      unitIndex: number;
      group: number;
      role: "leader" | "support" | "bodyguard";
    }[] = [];
    let attachmentGroup: number | null = null;
    let pendingAttachmentRole: "support" | null = null;

    const closePreamble = (): void => {
      if (!preamble_open) return;
      preamble_open = false;
      let parts = [...preamble_lines];
      const dispositionIndex = parts.findIndex((part) =>
        FORCE_DISPOSITION_NAMES.has(part.toLowerCase()),
      );
      if (dispositionIndex >= 0) {
        force_disposition_raw_name ??= parts[dispositionIndex];
        parts = parts.filter((_, index) => index !== dispositionIndex);
      }
      if (faction_raw_name === null && parts.length > 0) {
        faction_raw_name = parts.shift()!;
        if (
          parts.length > 1 &&
          GENERIC_FACTION_BREADCRUMBS.has(faction_raw_name.toLowerCase())
        ) {
          faction_raw_name = parts.shift()!;
        }
      }
      if (detachment_raw_names.length === 0 && parts.length > 0) {
        // Preserve logical preamble lines separately. The resolver has the
        // dataset needed to distinguish faction/detachment metadata from event
        // comments; joining them here destroys that boundary.
        detachment_raw_names.push(
          ...parts
            .map((part) =>
              part.replace(
                /\s*\(\s*\d+\s+(?:Detachment Points?|DP|PD)\s*\)\s*$/i,
                "",
              ),
            )
            .filter(Boolean),
        );
      }
    };

    const flush = (): void => {
      if (current) {
        const unitIndex = units.length;
        units.push(finishUnit(current));
        if (current.attachment_group !== null && current.attachment_role !== null) {
          attachmentMembers.push({
            unitIndex,
            group: current.attachment_group,
            role: current.attachment_role,
          });
        }
        current = null;
      }
    };

    const lines = expandDenseLines(text);
    for (const rawLine of lines) {
      const raw = rawLine.replace(/\r+$/, "");
      const line = raw.trim();
      if (!line) continue;

      // Bullets attach to the open unit.
      const bullet = RE_BULLET.exec(raw);
      if (bullet) {
        if (current) {
          const markerDepth = bullet[2] === "◦" ? 1 : 0;
          const parsedBullet = parseBullet(bullet[1].length + markerDepth, bullet[3], true);
          current.bullets.push(parsedBullet);
          current.attachment_role ??= parsedBullet.attachment_role;
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
      if (preamble_open && current === null && units.length === 0) {
        const metadata = /^([^:]{1,32}):\s*(.+)$/.exec(line);
        if (metadata) {
          const key = metadata[1].trim().toLowerCase();
          const value = metadata[2].trim();
          if (key === "player" || key === "team") continue;
          if (key === "list name") {
            name = value;
            consumed_title = true;
            continue;
          }
          if (key === "faction" || key === "factions" || key === "faction keyword") {
            faction_raw_name = value;
            consumed_title = true;
            continue;
          }
          if (/^det(?:a|at)chments?$/.test(key)) {
            detachment_raw_names.push(
              value.replace(/\s*\(\d+\s+(?:Detachment Points?|PD)\)\s*$/i, ""),
            );
            consumed_title = true;
            continue;
          }
          if (/^force dispositions?$/.test(key)) {
            force_disposition_raw_name = value
              .replace(/\s*\(selected\)\.?\s*$/i, "")
              .split(/\s*,\s*/)[0];
            consumed_title = true;
            continue;
          }
          if (key === "battle size") {
            battle_size_raw = value;
            const points = RE_PTS_LINE.exec(value);
            if (points) declared_limit = parsePts(points[2]);
            consumed_title = true;
            continue;
          }
        }
      }
      const looseBattleSize = /^(Combat Patrol|Incursion|Strike Force|Onslaught)\b/i.exec(
        line,
      );
      if (preamble_open && current === null && units.length === 0 && looseBattleSize) {
        battle_size_raw = line;
        declared_limit = parsePts(line);
        if (
          force_disposition_raw_name !== null ||
          preamble_lines.some((part) => FORCE_DISPOSITION_NAMES.has(part.toLowerCase()))
        ) {
          closePreamble();
        }
        continue;
      }
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
        closePreamble();
        flush();
        const pts = RE_PTS_LINE.exec(md[1]);
        section = pts ? pts[1].trim() : md[1].trim();
        continue;
      }

      // A bare points line is the roster total when no title was supplied. It
      // is metadata, never a unit or faction token.
      const barePoints = RE_BARE_POINTS_LINE.exec(line);
      if (barePoints) {
        total_reported ??= parsePts(barePoints[1]);
        consumed_title = true;
        continue;
      }

      const pts = RE_PTS_LINE.exec(line);
      if (pts) {
        const header_name = pts[1].trim();
        const points = parsePts(pts[2]);
        // Battle-size metadata may appear before or after the detachment and
        // disposition. Record it without closing the preamble; the first body
        // section/unit closes and classifies the complete metadata set.
        if (isBattleSize(header_name)) {
          battle_size_raw = line;
          if (points !== null) declared_limit = points;
          continue;
        }
        if (
          current === null &&
          units.length === 0 &&
          /\bDetachment Points?\b/i.test(line)
        ) {
          preamble_lines.push(line);
          continue;
        }
        // First `Name (N pts|Points)` line is the roster title, not a unit. Its
        // number is the army total; the later battle-size line is the limit.
        if (!consumed_title && current === null && units.length === 0) {
          consumed_title = true;
          name = header_name;
          total_reported = points;
          continue;
        }
        // Some event exports prepend participant/team lines without a fence.
        // Their actual high-point roster title arrives afterwards. No unit in
        // the supported game data costs 1,000+ points, so this remains
        // unambiguous even when no faction breadcrumbs intervened.
        if (
          declared_limit === null &&
          current === null &&
          units.length === 0 &&
          (points ?? 0) >= 1000
        ) {
          name = header_name;
          total_reported = points;
          if (preamble_lines.length >= 2) {
            preamble_lines.splice(0, preamble_lines.length - 1);
          } else {
            preamble_lines.length = 0;
          }
          continue;
        }
        // A real unit header.
        closePreamble();
        flush();
        const inChars = section?.toLowerCase() === CHARACTERS_SECTION.toLowerCase();
        if (section === ALLIED_SECTION) allied += 1;
        current = {
          raw_name: header_name,
          displayed_pts: points,
          is_character_section: inChars,
          bullets: [],
          attachment_group: attachmentGroup,
          attachment_role: pendingAttachmentRole,
        };
        pendingAttachmentRole = null;
        continue;
      }

      const attachedGroup = /^attached unit\s+(\d+)$/i.exec(line);
      if (attachedGroup) {
        closePreamble();
        flush();
        section = "ATTACHED UNITS";
        attachmentGroup = Number.parseInt(attachedGroup[1], 10);
        continue;
      }

      if (/^attached as support\s*:?\s*$/i.test(line)) {
        closePreamble();
        flush();
        pendingAttachmentRole = "support";
        continue;
      }

      // `Attached Units` is a body section even when it isn't uppercased. Close
      // the preamble before its numbered `Attached Unit N` subheadings.
      if (RE_ATTACHED_SECTION.test(line)) {
        closePreamble();
        flush();
        section = "ATTACHED UNITS";
        attachmentGroup = null;
        continue;
      }

        if (
          preamble_open &&
          current === null &&
          units.length === 0 &&
          RE_CAPS_SECTION.test(line) &&
          !RE_BODY_SECTION.test(line)
        ) {
          preamble_lines.push(line);
          continue;
        }
      // Section headers without points (ALL-CAPS role, `Title:` colon).
      if (RE_CAPS_SECTION.test(line) || RE_COLON_SECTION.test(line)) {
        closePreamble();
        flush();
        section = line.replace(/:\s*$/, "").trim();
        attachmentGroup = null;
        continue;
      }

      // Anything else before the body is title/preamble metadata. A URL
      // anywhere on a leading note line is event commentary, not a ListForge
      // payload or roster name.
      if (preamble_open && /https?:\/\//i.test(line)) continue;
      if (!consumed_title && current === null && units.length === 0) {
        consumed_title = true;
        name = line;
      } else if (preamble_open && current === null && units.length === 0) {
        preamble_lines.push(line);
      }
    }
    closePreamble();
    flush();

    for (const group of new Set(attachmentMembers.map((member) => member.group))) {
      const members = attachmentMembers.filter((member) => member.group === group);
      const bodyguard = members.find((member) => member.role === "bodyguard");
      if (!bodyguard) continue;
      for (const member of members) {
        if (member.role === "bodyguard") continue;
        units[member.unitIndex].leader_attachment = {
          bodyguard_raw_name: units[bodyguard.unitIndex].raw_name,
          role: member.role,
          provisional: false,
        };
      }
    }
    if (summaryWarlord) {
      const key = summaryWarlord.toLocaleLowerCase();
      const matches = units.filter((unit) => unit.raw_name.toLocaleLowerCase().startsWith(key));
      if (matches.length === 1) {
        for (const unit of units) unit.is_warlord = false;
        matches[0].is_warlord = true;
      }
    }

    let total_computed = 0;
    for (const u of units) {
      total_computed += (u.points ?? 0) + (u.enhancement_points ?? 0);
    }
    const effectiveLimit = declared_limit ?? total_reported;

    return {
      name,
      generated_by: null,
      faction_raw_name,
      detachment_raw_names,
      battle_size_raw: battle_size_raw ?? inferBattleSizeRaw(effectiveLimit),
      force_disposition_raw_name,
      declared_limit: effectiveLimit,
      total_reported,
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
  expandDenseLines,
};
