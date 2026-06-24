/**
 * Export formatters for flagged abilities. Pure functions over a plain record
 * shape so they're trivially testable and the output pastes straight into an
 * LLM / the `author-ability` flow for DSL fixes.
 */

export interface FlaggedRecord {
  ability_id: string;
  name: string;
  faction_id: string | null;
  flagged: boolean;
  note: string;
  /** Source text from the store (may be empty when the store has none). */
  source_text: string;
  /** The structured DSL — the raw ability record. */
  dsl: unknown;
  /** Describer output generated from the DSL. */
  describer: string;
  /** Describer fingerprint captured when the entry was last reviewed (undefined for legacy/no-baseline entries). */
  reviewed_fingerprint?: string;
  /** Fingerprint of the current describer output. */
  current_fingerprint: string;
  /** True when a reviewed fingerprint exists and the DSL's describer has changed since. */
  stale: boolean;
}

export function toJson(records: FlaggedRecord[]): string {
  return JSON.stringify(
    {
      tool: "40kdc data-explorer",
      kind: "ability-dsl-review",
      count: records.length,
      items: records,
    },
    null,
    2,
  );
}

export function toMarkdown(records: FlaggedRecord[]): string {
  const lines: string[] = [
    "# 40kdc ability DSL review",
    "",
    `${records.length} flagged ${records.length === 1 ? "ability" : "abilities"}.`,
    "",
    "Each entry pairs the source rule text with the community DSL and the",
    "description that DSL currently generates. Where they disagree, fix the DSL.",
    "",
  ];

  for (const r of records) {
    lines.push(`## ${r.name} \`${r.ability_id}\`${r.stale ? " ⚠️ (changed since reviewed)" : ""}`);
    if (r.faction_id) lines.push(`*Faction:* ${r.faction_id}`);
    if (r.stale) {
      lines.push(
        "*The DSL's describer output has changed since this was flagged — re-verify the note still applies.*",
      );
    }
    lines.push("");
    if (r.note.trim()) {
      lines.push(`**Note:** ${r.note.trim()}`, "");
    }
    lines.push("**Source text**", "");
    lines.push("```", r.source_text.trim() || "(no source text available)", "```", "");
    lines.push("**Describer output**", "");
    lines.push("```", r.describer.trim() || "(empty)", "```", "");
    lines.push("**DSL**", "");
    lines.push("```json", JSON.stringify(r.dsl, null, 2), "```", "");
  }

  return lines.join("\n");
}

/** Trigger a browser download of `text` as `filename`. No-op outside the DOM. */
export function download(filename: string, text: string, mime = "text/plain"): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
