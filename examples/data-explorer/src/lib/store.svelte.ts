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
  /** Roundtrip collation scope: true = every ability of the faction; false = the
   *  selected unit's abilities only. */
  roundtripAll = $state(true);
  /** Name/id filter applied to the roundtrip collation. Lives on the store so it
   *  survives switching views. */
  abilitySearch = $state("");
  sourceSpec = $state<string>(loadSourceSpec());

  setSource(spec: string): void {
    this.sourceSpec = spec;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(LS_SOURCE, spec);
    } catch {
      // Non-fatal.
    }
  }

  /** Jump to the roundtrip view focused on a specific ability. Widen the scope to
   *  the whole faction so the ability is guaranteed to be in the collation, and
   *  clear the search so it isn't filtered out. */
  inspect(abilityId: string): void {
    this.abilityId = abilityId;
    this.roundtripAll = true;
    this.abilitySearch = "";
    this.view = "roundtrip";
  }
}

export const explorer = new ExplorerStore();
