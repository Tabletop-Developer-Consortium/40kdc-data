/**
 * Filters keywords for shared units to return only the target faction's view.
 *
 * Source data stores all views' keywords in a flat list, grouped by faction
 * keyword markers (is_faction_keyword === "true"). Each group starts with one
 * or more faction keyword entries, followed by regular keywords for that view.
 */

export interface SourceKeyword {
  datasheet_id: string;
  keyword: string;
  model: string;
  is_faction_keyword: string;
}

interface KeywordResult {
  factionKeywords: string[];
  regularKeywords: string[];
}

interface KeywordGroup {
  factionKeywords: string[];
  regularKeywords: string[];
}

/**
 * Split keywords into view groups delimited by faction keyword entries.
 * Each group starts when a faction keyword is encountered after regular keywords
 * (or at the start).
 */
function splitKeywordGroups(keywords: SourceKeyword[]): KeywordGroup[] {
  const groups: KeywordGroup[] = [];
  let current: KeywordGroup | null = null;

  for (const kw of keywords) {
    if (kw.is_faction_keyword === "true") {
      if (current === null || current.regularKeywords.length > 0) {
        // Start a new group when we see a faction keyword after regular ones
        // (or at the very start)
        if (current !== null) groups.push(current);
        current = { factionKeywords: [], regularKeywords: [] };
      }
      current!.factionKeywords.push(kw.keyword);
    } else {
      if (current === null) {
        current = { factionKeywords: [], regularKeywords: [] };
      }
      current.regularKeywords.push(kw.keyword);
    }
  }
  if (current !== null) groups.push(current);

  return groups;
}

/**
 * Get keywords for a specific faction from a shared unit's keyword list.
 * Finds the group whose faction keywords include `factionName` and returns
 * deduplicated faction + regular keywords for that view.
 *
 * For single-view units (one group), returns all keywords as-is.
 */
export function getKeywordsForFaction(
  keywords: SourceKeyword[],
  factionName: string
): KeywordResult {
  const groups = splitKeywordGroups(keywords);

  if (groups.length <= 1) {
    // Single-view unit — return everything
    const group = groups[0] ?? { factionKeywords: [], regularKeywords: [] };
    return {
      factionKeywords: [...new Set(group.factionKeywords)],
      regularKeywords: [...new Set(group.regularKeywords)],
    };
  }

  // Multi-view unit — find the group matching the target faction
  for (const group of groups) {
    if (group.factionKeywords.includes(factionName)) {
      return {
        factionKeywords: [...new Set(group.factionKeywords)],
        regularKeywords: [...new Set(group.regularKeywords)],
      };
    }
  }

  // Fallback: faction name not found in any group. Return all keywords
  // deduplicated — better than throwing for edge cases.
  const allFaction = new Set<string>();
  const allRegular = new Set<string>();
  for (const group of groups) {
    group.factionKeywords.forEach((k) => allFaction.add(k));
    group.regularKeywords.forEach((k) => allRegular.add(k));
  }
  console.warn(
    `Warning: faction "${factionName}" not found in keyword groups for ` +
      `datasheet ${keywords[0]?.datasheet_id}. Returning all keywords.`
  );
  return {
    factionKeywords: [...allFaction],
    regularKeywords: [...allRegular],
  };
}
