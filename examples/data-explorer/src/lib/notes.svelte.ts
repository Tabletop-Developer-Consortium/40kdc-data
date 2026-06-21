/**
 * Per-ability flag + free-text note, persisted to localStorage. The roundtrip
 * view writes here; the datacard reads `isFlagged` to badge flagged abilities;
 * the export builds from `exportableIds`.
 */

export interface NoteRecord {
  flagged: boolean;
  note: string;
}

const LS_KEY = "data-explorer:notes";

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

  toggleFlag(id: string): void {
    const cur = this.get(id);
    this.map = { ...this.map, [id]: { ...cur, flagged: !cur.flagged } };
    this.prune(id);
    this.persist();
  }

  setNote(id: string, note: string): void {
    const cur = this.get(id);
    this.map = { ...this.map, [id]: { ...cur, note } };
    this.prune(id);
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
