import { factions } from "@alpaca-software/40kdc-data";
import { DEFAULT_SOURCE } from "./source-store.js";

export type ExplorerView = "browse" | "roundtrip";

const LS_SOURCE = "data-explorer:source-spec";

function loadSourceSpec(): string {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_SOURCE;
    return localStorage.getItem(LS_SOURCE) ?? DEFAULT_SOURCE;
  } catch {
    return DEFAULT_SOURCE;
  }
}

/** Factions sorted by name, computed once — the picker's source list. */
export const sortedFactions = [...factions.all].sort((a, b) =>
  a.name.localeCompare(b.name),
);

class ExplorerStore {
  view = $state<ExplorerView>("browse");
  /** Selected faction id; defaults to the first faction so the card is populated. */
  factionId = $state<string | null>(sortedFactions[0]?.id ?? null);
  unitId = $state<string | null>(null);
  unitFilter = $state("");
  /** Ability selected for the roundtrip view (set from the datacard or the list). */
  abilityId = $state<string | null>(null);
  sourceSpec = $state<string>(loadSourceSpec());

  setSource(spec: string): void {
    this.sourceSpec = spec;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(LS_SOURCE, spec);
    } catch {
      // Non-fatal.
    }
  }

  /** Jump to the roundtrip view focused on a specific ability. */
  inspect(abilityId: string): void {
    this.abilityId = abilityId;
    this.view = "roundtrip";
  }
}

export const explorer = new ExplorerStore();
