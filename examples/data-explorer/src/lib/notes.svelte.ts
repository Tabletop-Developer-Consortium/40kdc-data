/**
 * Per-ability flag + free-text note, persisted to localStorage. The roundtrip
 * view writes here; the datacard reads `isFlagged` to badge flagged abilities;
 * the export builds from `exportableIds`.
 *
 * Each flag/note also records a `fingerprint` of the ability's describer output
 * at the moment it was reviewed. When the DSL is later re-authored and the
 * describer text changes, `isStale` reports the entry as "changed since
 * reviewed" so a stale flag surfaces instead of silently rotting. A record with
 * no fingerprint (e.g. one written before this feature) is treated as a neutral
 * "no baseline" — never stale — so an upgrade doesn't false-flag everything.
 */

export interface NoteRecord {
  flagged: boolean;
  note: string;
  /** Hash of the describer output captured when this entry was last reviewed. */
  fingerprint?: string;
}

const LS_KEY = "data-explorer:notes";

/**
 * Deterministic, dependency-free FNV-1a hash of a string → base36. Used to
 * fingerprint describer output; stable across reloads and implementations.
 */
export function fingerprintText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in unsigned 32-bit range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function load(): Record<string, NoteRecord> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, NoteRecord>) : {};
  } catch {
    return {};
  }
}

class NotesStore {
  map = $state<Record<string, NoteRecord>>(load());

  private persist(): void {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(LS_KEY, JSON.stringify(this.map));
    } catch {
      // Non-fatal: quota/disabled storage just means notes don't survive reload.
    }
  }

  get(id: string): NoteRecord {
    return this.map[id] ?? { flagged: false, note: "" };
  }

  isFlagged(id: string): boolean {
    return this.map[id]?.flagged === true;
  }

  /**
   * True iff the entry exists, carries a fingerprint, and the current describer
   * no longer matches it. A fingerprint-less (legacy) record is never stale.
   */
  isStale(id: string, currentDescriber: string): boolean {
    const r = this.map[id];
    if (!r || r.fingerprint == null) return false;
    return fingerprintText(currentDescriber) !== r.fingerprint;
  }

  toggleFlag(id: string, describer: string): void {
    const cur = this.get(id);
    this.map = {
      ...this.map,
      [id]: { ...cur, flagged: !cur.flagged, fingerprint: fingerprintText(describer) },
    };
    this.prune(id);
    this.persist();
  }

  setNote(id: string, note: string, describer: string): void {
    const cur = this.get(id);
    this.map = {
      ...this.map,
      [id]: { ...cur, note, fingerprint: fingerprintText(describer) },
    };
    this.prune(id);
    this.persist();
  }

  /** Re-baseline an entry's fingerprint to the current describer, keeping flag + note. */
  reaffirm(id: string, describer: string): void {
    const cur = this.map[id];
    if (!cur) return;
    this.map = { ...this.map, [id]: { ...cur, fingerprint: fingerprintText(describer) } };
    this.persist();
  }

  /** Drop a single entry (e.g. after verifying the fix that made it stale). */
  clear(id: string): void {
    if (!(id in this.map)) return;
    const next = { ...this.map };
    delete next[id];
    this.map = next;
    this.persist();
  }

  /** Drop an entry that is neither flagged nor noted, to keep storage tidy. */
  private prune(id: string): void {
    const r = this.map[id];
    if (r && !r.flagged && r.note.trim() === "") {
      const next = { ...this.map };
      delete next[id];
      this.map = next;
    }
  }

  /** Ids worth exporting: flagged, or carrying a note. */
  exportableIds(): string[] {
    return Object.keys(this.map).filter(
      (id) => this.map[id].flagged || this.map[id].note.trim() !== "",
    );
  }

  clearAll(): void {
    this.map = {};
    this.persist();
  }
}

export const notes = new NotesStore();
