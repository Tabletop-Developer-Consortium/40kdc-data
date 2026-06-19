/**
 * compact-json.ts — serialize data the way the repo's hand-authored core JSON is
 * formatted, so a tool that rewrites such a file produces a minimal, reviewable
 * diff (only the values that changed) instead of reflowing the whole file.
 *
 * The convention is purely STRUCTURAL — there is no line-width threshold:
 *
 *   - The root array and any array that contains objects/arrays break, one
 *     element per line.
 *   - An array of only scalars stays on one line: `["a", "b"]`.
 *   - An object's rendering depends on a propagated CONTEXT:
 *       · "block" context (array elements directly under a block array — entities,
 *         award blocks, action blocks) → each key on its own line.
 *       · "inline" context (any object that is a property VALUE — trigger, when,
 *         parameters, game_version, …) → the whole object on one line:
 *         `{ "k": v, "k": v }`, regardless of length.
 *   - Context propagates: an object value is always rendered inline; an array
 *     value inherits its containing object's context (so `awards` under a block
 *     entity breaks into block elements, while `operands` under an inline `when`
 *     breaks into inline elements). An inline object whose value is a breaking
 *     array yields the hugging hybrid `{ "op": "or", "operands": [ <newline> … ] }`.
 *
 * Verified byte-identical against data/core/secondary-cards.json, missions.json,
 * mission-matchups.json, and force-dispositions.json (see compact-json.test.ts).
 * `formatCompact(JSON.parse(text)) === text` is the contract those tests pin.
 */

type Ctx = "block" | "inline";

const isContainer = (v: unknown): v is object => v !== null && typeof v === "object";
const arrayBreaks = (a: unknown[]): boolean => a.some(isContainer);

function renderArray(arr: unknown[], indent: string, ctx: Ctx): string {
  if (arr.length === 0) return "[]";
  if (!arrayBreaks(arr)) return "[" + arr.map((e) => JSON.stringify(e)).join(", ") + "]";
  const inner = indent + "  ";
  const parts = arr.map(
    (e) =>
      inner +
      (Array.isArray(e)
        ? renderArray(e, inner, ctx)
        : isContainer(e)
          ? renderObject(e as Record<string, unknown>, inner, ctx)
          : JSON.stringify(e))
  );
  return "[\n" + parts.join(",\n") + "\n" + indent + "]";
}

function renderObject(obj: Record<string, unknown>, indent: string, ctx: Ctx): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  // In block context the key sits on its own line at indent+2, so a value array
  // indents from there; in inline context the key is on the brace line at
  // `indent`, so its value array indents from `indent`.
  const childIndent = ctx === "block" ? indent + "  " : indent;
  const renderVal = (v: unknown): string =>
    Array.isArray(v)
      ? renderArray(v, childIndent, ctx)
      : isContainer(v)
        ? renderObject(v as Record<string, unknown>, childIndent, "inline")
        : JSON.stringify(v);
  if (ctx === "block") {
    const inner = indent + "  ";
    return (
      "{\n" +
      keys.map((k) => inner + JSON.stringify(k) + ": " + renderVal(obj[k])).join(",\n") +
      "\n" +
      indent +
      "}"
    );
  }
  return "{ " + keys.map((k) => JSON.stringify(k) + ": " + renderVal(obj[k])).join(", ") + " }";
}

/**
 * Serialize a value in the repo's compact hand-authored style, with a trailing
 * newline. Round-trips the listed core data files byte-for-byte.
 */
export function formatCompact(data: unknown): string {
  const body = Array.isArray(data)
    ? renderArray(data, "", "block")
    : isContainer(data)
      ? renderObject(data as Record<string, unknown>, "", "block")
      : JSON.stringify(data);
  return body + "\n";
}
