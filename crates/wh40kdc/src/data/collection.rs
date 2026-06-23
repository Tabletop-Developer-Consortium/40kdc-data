//! A queryable view over one entity collection.
//!
//! Indexes (by id, by normalized name, by faction) are built once at
//! construction. Records are deduplicated by a caller-supplied key (default:
//! id, first occurrence wins). Some records are intentionally shared: the same
//! unit id (e.g. `ministorum-priest`) appears under several factions, so units
//! dedupe on `(faction_id, id)` to keep each faction's copy, while identical
//! core abilities copied into many faction files dedupe away on `ability_id`.
//!
//! [`get`](Collection::get) / [`find`](Collection::find) return the first match
//! when an id is shared across factions; use
//! [`by_faction`](Collection::by_faction) or
//! [`find_all`](Collection::find_all) to disambiguate.
//!
//! This mirrors the TypeScript `Collection` (`tools/src/data/collection.ts`);
//! unlike TS it stores owned records and hands back borrows (`&T`) rather than
//! lazily-wrapped view objects.

use std::collections::HashMap;

use super::normalize::normalize_name;

/// A collection of one entity type, exposing id / name / faction lookups.
///
/// `T` is the raw (generated) record type. Built via [`Collection::build`],
/// which takes extractor closures but does not retain them — every index is
/// precomputed, so the struct holds no borrows and is free of self-referential
/// lifetimes.
pub struct Collection<T> {
    items: Vec<T>,
    by_id: HashMap<String, usize>,
    by_norm: HashMap<String, Vec<usize>>,
    by_faction: HashMap<String, Vec<usize>>,
    /// Normalized name per item (parallel to `items`), for the substring fallback.
    norm_names: Vec<Option<String>>,
}

impl<T> Collection<T> {
    /// Build a collection, indexing each kept record by id, normalized name, and
    /// faction.
    ///
    /// - `id_of` — the record's primary id (e.g. `|u| u.id.to_string()`).
    ///   Returns an owned `String` so string-newtype ids (`EntityId`) and
    ///   `Display`-based string enums (e.g. `ForceDispositionId`) work alike;
    ///   it is only invoked at build time.
    /// - `name_of` — its display name, if any (drives [`find`](Self::find)).
    /// - `faction_of` — its owning faction id, if any (drives
    ///   [`by_faction`](Self::by_faction)).
    /// - `dedupe_of` — the uniqueness key; first occurrence wins. Pass a
    ///   composite (e.g. `(faction_id, id)`) for records that legitimately share
    ///   an id across factions so distinct copies are preserved.
    pub fn build(
        items: Vec<T>,
        id_of: impl Fn(&T) -> String,
        name_of: impl Fn(&T) -> Option<&str>,
        faction_of: impl Fn(&T) -> Option<&str>,
        dedupe_of: impl Fn(&T) -> String,
    ) -> Self {
        // No aliases by default — only some collections (units) answer to them.
        Self::build_with_aliases(items, id_of, name_of, |_| Vec::new(), faction_of, dedupe_of)
    }

    /// Like [`build`](Self::build) but also indexes alternate names.
    ///
    /// - `aliases_of` — alternate names the record answers to (e.g. spelling
    ///   variants from other tools' exports). Each is indexed into the
    ///   normalized-name map alongside the canonical name, so
    ///   [`find`](Self::find) / [`find_all`](Self::find_all) match an alias
    ///   exactly — but an alias is never returned as the record's display name,
    ///   and the canonical name always wins a collision (aliases are appended
    ///   after the canonical entry and any alias that normalizes to the record's
    ///   own canonical name is skipped). Mirror of the TS `aliasesOf`.
    pub fn build_with_aliases(
        items: Vec<T>,
        id_of: impl Fn(&T) -> String,
        name_of: impl Fn(&T) -> Option<&str>,
        aliases_of: impl Fn(&T) -> Vec<&str>,
        faction_of: impl Fn(&T) -> Option<&str>,
        dedupe_of: impl Fn(&T) -> String,
    ) -> Self {
        let mut kept: Vec<T> = Vec::with_capacity(items.len());
        let mut by_id: HashMap<String, usize> = HashMap::new();
        let mut by_norm: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_faction: HashMap<String, Vec<usize>> = HashMap::new();
        let mut norm_names: Vec<Option<String>> = Vec::with_capacity(items.len());
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for item in items {
            if !seen.insert(dedupe_of(&item)) {
                continue; // first-wins dedup
            }
            let idx = kept.len();

            // First-wins for shared ids (a later faction copy doesn't clobber).
            by_id.entry(id_of(&item)).or_insert(idx);

            let norm = name_of(&item).map(normalize_name);
            if let Some(key) = &norm {
                by_norm.entry(key.clone()).or_default().push(idx);
            }
            // Index aliases after the canonical name, skipping empties and any
            // alias that normalizes to the canonical name, so an alias can never
            // displace the canonical owner of a normalized key.
            for alias in aliases_of(&item) {
                let alias_key = normalize_name(alias);
                if alias_key.is_empty() || norm.as_deref() == Some(alias_key.as_str()) {
                    continue;
                }
                by_norm.entry(alias_key).or_default().push(idx);
            }
            norm_names.push(norm);

            if let Some(faction) = faction_of(&item) {
                by_faction.entry(faction.to_string()).or_default().push(idx);
            }

            kept.push(item);
        }

        Self {
            items: kept,
            by_id,
            by_norm,
            by_faction,
            norm_names,
        }
    }

    /// Every record, deduplicated, in first-seen order.
    pub fn all(&self) -> &[T] {
        &self.items
    }

    /// Number of distinct records.
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Whether the collection holds no records.
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Look up by exact id.
    pub fn get(&self, id: &str) -> Option<&T> {
        self.by_id.get(id).map(|&i| &self.items[i])
    }

    /// Whether a record with this exact id exists.
    pub fn has(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }

    /// Record at a stored index (used by [`Dataset`](super::Dataset)'s reverse
    /// indexes, which hold `usize` positions into this collection).
    pub(super) fn at(&self, idx: usize) -> &T {
        &self.items[idx]
    }

    /// Find one record by id or name, returning the first match.
    ///
    /// Name matching is diacritic- and punctuation-insensitive (see
    /// [`normalize_name`](super::normalize_name)), trying in order: exact id →
    /// exact normalized name → normalized-name substring. Names can repeat
    /// across factions, so use [`find_all`](Self::find_all) or
    /// [`by_faction`](Self::by_faction) when a query may be ambiguous.
    pub fn find(&self, query: &str) -> Option<&T> {
        self.find_all(query).into_iter().next()
    }

    /// All records matching a query, by the same rules as [`find`](Self::find).
    ///
    /// An exact id match returns just that record; otherwise every
    /// normalized-name-exact match is returned, falling back to every
    /// normalized-name-substring match. Surfaces (rather than silently
    /// collapses) names shared across factions.
    pub fn find_all(&self, query: &str) -> Vec<&T> {
        if let Some(&i) = self.by_id.get(query) {
            return vec![&self.items[i]];
        }
        let key = normalize_name(query);
        if let Some(idxs) = self.by_norm.get(&key) {
            if !idxs.is_empty() {
                return idxs.iter().map(|&i| &self.items[i]).collect();
            }
        }
        if key.is_empty() {
            return Vec::new();
        }
        self.norm_names
            .iter()
            .enumerate()
            .filter_map(|(i, n)| match n {
                Some(name) if name.contains(&key) => Some(&self.items[i]),
                _ => None,
            })
            .collect()
    }

    /// All records belonging to a faction id (empty if the type has no faction).
    pub fn by_faction(&self, faction_id: &str) -> Vec<&T> {
        self.by_faction
            .get(faction_id)
            .map(|idxs| idxs.iter().map(|&i| &self.items[i]).collect())
            .unwrap_or_default()
    }

    /// Iterate the distinct records in first-seen order.
    pub fn iter(&self) -> std::slice::Iter<'_, T> {
        self.items.iter()
    }
}

impl<'a, T> IntoIterator for &'a Collection<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.items.iter()
    }
}
