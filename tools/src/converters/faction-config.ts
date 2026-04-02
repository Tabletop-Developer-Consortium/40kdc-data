/**
 * Faction-specific configuration for the generic converter.
 *
 * Each faction provides a config that parameterizes the conversion pipeline.
 * Configs are stored in ./configs/ and imported by convert-faction.ts.
 */

export interface ModelEntry {
  name: string;
  profile_name?: string | null;
  min: number;
  max: number;
  default_weapon_ids?: string[];
  is_leader_model: boolean;
}

export interface FactionConfig {
  /** Source faction ID in army-assist data (e.g., "WE", "EC"). */
  sourceFactionId: string;

  /** 40kdc entity ID (e.g., "world-eaters", "emperors-children"). */
  factionId: string;

  /** Display name (e.g., "World Eaters", "Emperor's Children"). */
  factionName: string;

  /** Faction ability name used for view selection on shared units. */
  factionAbilityName: string;

  /** 40kdc ID for the faction rule ability (e.g., "blessings-of-khorne"). */
  factionRuleId: string;

  /** Top-level faction keywords (e.g., ["Chaos", "Khorne", "World Eaters"]). */
  factionKeywords: string[];

  /** Parent faction ID if this is a subfaction, null otherwise. */
  parentFactionId: string | null;

  /** Aliases for the faction name. */
  aliases: string[];

  /**
   * Manual composition overrides for multi-model units.
   * Keyed by 40kdc unit ID (e.g., "khorne-berzerkers").
   * Single-model units (vehicles, characters) get auto-generated compositions.
   */
  compositionOverrides: Record<string, ModelEntry[]>;

  /**
   * For subfactions that share a source faction (e.g., SM chapters):
   * only include detachments whose names match this list.
   * Stratagems and enhancements are filtered to matching detachments.
   * If undefined, all detachments are included.
   */
  detachmentFilter?: string[];

  /**
   * If true, skip unit/weapon/leader-attachment/unit-composition generation.
   * Used by subfactions whose units are inherited from the parent faction.
   */
  skipUnits?: boolean;
}

/** Registry of all known faction configs, keyed by 40kdc faction ID. */
const registry = new Map<string, FactionConfig>();

export function registerFaction(config: FactionConfig): void {
  registry.set(config.factionId, config);
}

export function getFactionConfig(factionId: string): FactionConfig {
  const config = registry.get(factionId);
  if (!config) {
    const available = [...registry.keys()].join(", ");
    throw new Error(
      `Unknown faction "${factionId}". Available: ${available}`
    );
  }
  return config;
}

export function listFactions(): string[] {
  return [...registry.keys()].sort();
}
