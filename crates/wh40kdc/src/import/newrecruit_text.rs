//! Helpers shared by the three NewRecruit text adapters (wtc-compact,
//! wtc-full, simple). These are pure string-massage utilities: they take
//! format-specific tokens and turn them into the format-agnostic
//! [`ParsedRoster`](super::types::ParsedRoster) pieces.
//!
//! No business knowledge of dataset entities lives here — name resolution is
//! still [`resolve`](super::resolve)'s job downstream.
//!
//! Rust mirror of `tools/src/import/newrecruit-text.ts`.

use super::types::ParsedWargear;

/// Tournament-standard battle sizes by points ceiling (10th ed).
const BATTLE_SIZES: &[(u64, &str)] = &[
    (500, "Combat Patrol (500 Point limit)"),
    (1000, "Incursion (1000 Point limit)"),
    (2000, "Strike Force (2000 Point limit)"),
    (3000, "Onslaught (3000 Point limit)"),
];

/// Synthesize a `ParsedRoster::battle_size_raw` from a points limit. The
/// wtc/simple formats don't carry the battle-size label explicitly — they
/// only report the total army points — so we map the limit to its standard
/// label.
pub fn infer_battle_size_raw(limit: Option<u64>) -> Option<String> {
    let limit = limit?;
    for (upper, label) in BATTLE_SIZES {
        if limit <= *upper {
            return Some((*label).to_string());
        }
    }
    Some(BATTLE_SIZES[BATTLE_SIZES.len() - 1].1.to_string())
}

/// Outcome of classifying a comma-separated wargear list.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ClassifiedTokens {
    pub wargear: Vec<ParsedWargear>,
    pub is_warlord: bool,
    pub is_character: bool,
    pub keyword_overrides: Vec<String>,
    /// Enhancement raw name, when one was inlined in the wargear list
    /// (simple format).
    pub enhancement_raw_name: Option<String>,
    /// Enhancement points cost when given inline (simple format), else None.
    pub enhancement_points: Option<u64>,
}

const CHARACTER_SUFFIX: &str = " Character";
const WARLORD_MARKER: &str = "Warlord";
const INLINE_ENHANCEMENT_PREFIX: &str = "Enhancement:";
const INLINE_KEYWORD_PREFIX: &str = "40kdc Keyword";

/// Match leading `Nx ` on a token, returning `(count, rest)` when present.
fn match_nx_prefix(token: &str) -> Option<(u64, &str)> {
    let bytes = token.as_bytes();
    let mut end = 0;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == 0 || end >= bytes.len() {
        return None;
    }
    if bytes[end] != b'x' {
        return None;
    }
    let after_x = end + 1;
    if after_x >= bytes.len() || !bytes[after_x].is_ascii_whitespace() {
        return None;
    }
    let count: u64 = token[..end].parse().ok()?;
    let rest = token[after_x..].trim_start();
    if rest.is_empty() {
        return None;
    }
    Some((count, rest))
}

/// Match `Name [N pts]` (case-insensitive `pts`), returning `(name, pts)`.
fn match_inline_pts(token: &str) -> Option<(&str, u64)> {
    let open = token.rfind('[')?;
    let close = token.rfind(']')?;
    if close <= open {
        return None;
    }
    let inner = token[open + 1..close].trim();
    let after = token[close + 1..].trim();
    if !after.is_empty() {
        return None;
    }
    // Inner shape: "<digits> pts" (or "pt").
    let inner_lower = inner.to_ascii_lowercase();
    let trimmed = inner_lower.trim_end_matches('s').trim_end_matches("pt");
    let digits = trimmed.trim();
    let pts: u64 = digits.parse().ok()?;
    let name = token[..open].trim_end();
    if name.is_empty() {
        return None;
    }
    Some((name, pts))
}

/// Classify each token in a comma-separated wargear list. Strips the markers
/// that aren't real wargear — `Warlord`, the detachment "<Name> Character"
/// keyword, and the inline `Name [N pts]` enhancement (simple format) — and
/// collects everything else as [`ParsedWargear`] with optional `Nx` count.
pub fn classify_wargear_list(tokens: &[&str]) -> ClassifiedTokens {
    let mut out = ClassifiedTokens::default();

    for raw in tokens {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }

        if token == WARLORD_MARKER {
            out.is_warlord = true;
            continue;
        }
        if token.ends_with(CHARACTER_SUFFIX) {
            out.is_character = true;
            if !out
                .keyword_overrides
                .iter()
                .any(|keyword| keyword == "Character")
            {
                out.keyword_overrides.push("Character".to_string());
            }
            continue;
        }
        let keyword_suffix = token
            .get(..INLINE_KEYWORD_PREFIX.len())
            .filter(|prefix| prefix.eq_ignore_ascii_case(INLINE_KEYWORD_PREFIX))
            .map(|_| &token[INLINE_KEYWORD_PREFIX.len()..]);
        if let Some(keyword) = keyword_suffix
            .and_then(|suffix| {
                suffix
                    .strip_prefix("s:")
                    .or_else(|| suffix.strip_prefix(':'))
            })
            .map(str::trim)
            .filter(|keyword| !keyword.is_empty())
        {
            if !out
                .keyword_overrides
                .iter()
                .any(|existing| existing == keyword)
            {
                out.keyword_overrides.push(keyword.to_string());
            }
            continue;
        }

        if let Some((name, pts)) = match_inline_pts(token) {
            if out.enhancement_raw_name.is_none() {
                out.enhancement_raw_name = Some(name.to_string());
                out.enhancement_points = Some(pts);
            }
            continue;
        }
        if let Some(name) = token
            .strip_prefix(INLINE_ENHANCEMENT_PREFIX)
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            if out.enhancement_raw_name.is_none() {
                out.enhancement_raw_name = Some(name.to_string());
            }
            continue;
        }

        if let Some((count, rest)) = match_nx_prefix(token) {
            let count = if count > 0 { count } else { 1 };
            out.wargear.push(ParsedWargear {
                raw_name: rest.trim().to_string(),
                count,
            });
        } else {
            out.wargear.push(ParsedWargear {
                raw_name: token.to_string(),
                count: 1,
            });
        }
    }

    out
}

/// Split a wargear list on top-level commas. (No nested parentheses with
/// commas are produced by NewRecruit, so a plain split is enough.)
pub fn split_wargear_list(text: &str) -> Vec<&str> {
    text.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// Strip a trailing parenthetical (e.g. "Houndpack Lance (Marked Prey)" →
/// "Houndpack Lance").
pub fn strip_parenthetical(name: &str) -> &str {
    match name.find('(') {
        Some(i) => name[..i].trim_end(),
        None => name.trim(),
    }
}

/// Pull the primary faction out of a "Super - Sub" keyword, e.g.
/// "Chaos - Chaos Knights" → "Chaos Knights". Shared by the wtc and GW headers.
pub fn faction_from_keyword(value: &str) -> String {
    value
        .rsplit(" - ")
        .next()
        .unwrap_or(value)
        .trim()
        .to_string()
}

/// Parse a `(N pts)` or `[N pts]` suffix from a unit header line. Currently
/// only used by tests — the WTC and simple adapters pull points off explicit
/// regex captures rather than calling this helper. Kept for parity with the
/// TS `pointsFrom`, since a future adapter may want it.
#[allow(dead_code)]
pub fn points_from(token: &str) -> Option<u64> {
    // Look for the last occurrence of `(` … `pts)` or `[` … `pts]`.
    parse_pts_with(token, '(', ')').or_else(|| parse_pts_with(token, '[', ']'))
}

#[allow(dead_code)]
fn parse_pts_with(token: &str, open: char, close: char) -> Option<u64> {
    // Find the *last* matched pair so trailing pts overrides any earlier brackets.
    let close_idx = token.rfind(close)?;
    let open_idx = token[..close_idx].rfind(open)?;
    let inner = token[open_idx + 1..close_idx].trim();
    let lower = inner.to_ascii_lowercase();
    // Strip trailing `pts`/`pt` and any leading `+`.
    let trimmed = lower
        .trim_end_matches('s')
        .trim_end_matches("pt")
        .trim()
        .trim_start_matches('+')
        .trim();
    trimmed.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_battle_size_buckets() {
        assert_eq!(infer_battle_size_raw(None), None);
        assert_eq!(
            infer_battle_size_raw(Some(500)).as_deref(),
            Some("Combat Patrol (500 Point limit)")
        );
        assert_eq!(
            infer_battle_size_raw(Some(501)).as_deref(),
            Some("Incursion (1000 Point limit)")
        );
        assert_eq!(
            infer_battle_size_raw(Some(2000)).as_deref(),
            Some("Strike Force (2000 Point limit)")
        );
        assert_eq!(
            infer_battle_size_raw(Some(5000)).as_deref(),
            Some("Onslaught (3000 Point limit)")
        );
    }

    #[test]
    fn classify_warlord_and_character() {
        let c = classify_wargear_list(&["Warlord", "Houndpack Lance Character", "Bolter"]);
        assert!(c.is_warlord);
        assert!(c.is_character);
        assert_eq!(c.wargear.len(), 1);
        assert_eq!(c.wargear[0].raw_name, "Bolter");
        assert_eq!(c.wargear[0].count, 1);
        assert!(c.enhancement_raw_name.is_none());
    }

    #[test]
    fn classify_inline_enhancement() {
        let c = classify_wargear_list(&["Preyslayer's Mantle [15 pts]", "Chainsword"]);
        assert_eq!(
            c.enhancement_raw_name.as_deref(),
            Some("Preyslayer's Mantle")
        );
        assert_eq!(c.enhancement_points, Some(15));
        assert_eq!(c.wargear.len(), 1);
    }

    #[test]
    fn classify_nx_prefix() {
        let c = classify_wargear_list(&["2x War Dog autocannon", "Reaper chaintalon"]);
        assert_eq!(c.wargear.len(), 2);
        assert_eq!(c.wargear[0].raw_name, "War Dog autocannon");
        assert_eq!(c.wargear[0].count, 2);
        assert_eq!(c.wargear[1].count, 1);
    }

    #[test]
    fn split_wargear() {
        assert_eq!(
            split_wargear_list("a, b ,  c ,, d"),
            vec!["a", "b", "c", "d"]
        );
    }

    #[test]
    fn strip_paren() {
        assert_eq!(
            strip_parenthetical("Houndpack Lance (Marked Prey)"),
            "Houndpack Lance"
        );
        assert_eq!(strip_parenthetical("Plain Name"), "Plain Name");
    }

    #[test]
    fn points_from_variants() {
        assert_eq!(points_from("War Dog Karnivore (150 pts)"), Some(150));
        assert_eq!(points_from("Enhancement [15 pts]"), Some(15));
        assert_eq!(points_from("Enhancement (+15 pts)"), Some(15));
        assert_eq!(points_from("No pts here"), None);
    }
}
