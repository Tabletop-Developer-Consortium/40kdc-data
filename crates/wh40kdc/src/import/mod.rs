//! Army-list importer: turn an external list-builder export into a resolved
//! 40kdc [`Roster`].
//!
//! v1 supports ListForge's "share JSON" payload. The output is a [`Roster`]
//! keyed on 40kdc entity ids and validatable against
//! `schemas/core/roster.schema.json`. Resolution is lenient — unmatched names
//! are retained with candidate suggestions and summarised in diagnostics.
//!
//! The pipeline is three reusable stages: [`decode_listforge`] (share payload →
//! JSON), a [`FormatAdapter`] (JSON → [`ParsedRoster`]), and [`resolve`]
//! ([`ParsedRoster`] → [`Roster`]). Only the adapter is format-specific, so
//! supporting a new source format (New Recruit, Rosterizer, a native 40kdc
//! export) is one new [`FormatAdapter`] — `decode` and `resolve` are unchanged.
//!
//! ```no_run
//! use wh40kdc::Dataset;
//! use wh40kdc::import::import_listforge;
//!
//! // `input` is a ListForge URL, a bare base64 segment, or raw JSON.
//! # let input = "https://listforge.app/#/listforge/H4sIA…";
//! let roster = import_listforge(input, Dataset::embedded()).unwrap();
//! println!("resolved {} units", roster.diagnostics.resolved_units);
//! ```

// types are always compiled when this module is visible — both `import` and
// `export` features need them. The actual importer machinery (decode, the
// adapters, resolve) only compiles under `feature = "import"` since those
// pull in base64/flate2/regex/Dataset.
mod types;

#[cfg(feature = "import")]
mod adapter;
#[cfg(feature = "import")]
mod decode;
#[cfg(feature = "import")]
mod gw;
#[cfg(feature = "import")]
mod gw_headerless;
#[cfg(feature = "import")]
mod listforge;
#[cfg(feature = "import")]
mod listforge_text;
#[cfg(feature = "import")]
mod newrecruit_json;
#[cfg(feature = "import")]
mod newrecruit_simple;
#[cfg(feature = "import")]
mod newrecruit_text;
#[cfg(feature = "import")]
mod newrecruit_wtc;
#[cfg(feature = "import")]
mod resolve;
#[cfg(feature = "import")]
mod roster_json;
#[cfg(feature = "import")]
mod rosterizer;

pub use types::{
    AttachmentRole, BattleSize, Candidate, Diagnostics, GameVersionRef, ParsedRoster, ParsedUnit,
    ParsedWargear, ResolvedRef, Roster, RosterFormat, RosterLeaderAttachment, RosterLoadoutGroup,
    RosterPoints, RosterSource, RosterUnit, RosterWargear, Warning, WarningCode,
};

#[cfg(feature = "import")]
pub use adapter::{format_id, select_adapter, FormatAdapter, ParseError};
#[cfg(feature = "import")]
pub use decode::{decode_listforge, DecodeError};
#[cfg(feature = "import")]
pub use gw::GwAdapter;
#[cfg(feature = "import")]
pub use gw_headerless::GwHeaderlessAdapter;
#[cfg(feature = "import")]
pub use listforge::ListForgeAdapter;
#[cfg(feature = "import")]
pub use listforge_text::ListForgeTextAdapter;
#[cfg(feature = "import")]
pub use newrecruit_json::NewRecruitJsonAdapter;
#[cfg(feature = "import")]
pub use newrecruit_simple::NewRecruitSimpleAdapter;
#[cfg(feature = "import")]
pub use newrecruit_wtc::{NewRecruitWtcCompactAdapter, NewRecruitWtcFullAdapter};
#[cfg(feature = "import")]
pub use resolve::resolve;
#[cfg(feature = "import")]
pub use roster_json::RosterJsonAdapter;
#[cfg(feature = "import")]
pub use rosterizer::RosterizerAdapter;

#[cfg(feature = "import")]
use crate::data::Dataset;

/// An error importing an army list.
#[cfg(feature = "import")]
#[derive(Debug)]
pub enum ImportError {
    /// The share payload could not be decoded.
    Decode(DecodeError),
    /// No registered adapter recognised the payload, or it failed to parse.
    Parse(ParseError),
}

#[cfg(feature = "import")]
impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::Decode(e) => write!(f, "{e}"),
            ImportError::Parse(e) => write!(f, "{e}"),
        }
    }
}

#[cfg(feature = "import")]
impl std::error::Error for ImportError {}

#[cfg(feature = "import")]
impl From<DecodeError> for ImportError {
    fn from(e: DecodeError) -> Self {
        ImportError::Decode(e)
    }
}

#[cfg(feature = "import")]
impl From<ParseError> for ImportError {
    fn from(e: ParseError) -> Self {
        ImportError::Parse(e)
    }
}

/// The adapters available to [`import_roster`], in match-priority order.
///
/// NewRecruit-JSON runs ahead of ListForge because both recognise a
/// `roster.forces` BattleScribe payload; the NewRecruit signature is more
/// specific (xmlns or `generatedBy: newrecruit.eu`). The text adapters
/// (gw / wtc-full / wtc-compact / simple) only match `Value::String` payloads
/// and disambiguate among themselves via structural cues — wtc-full goes before
/// wtc-compact because its matcher is the more specific of the two. GW shares
/// the WTC summary header but carries `•` bullets and no `N with` lines, so it
/// stays disjoint from both wtc matchers.
#[cfg(feature = "import")]
fn adapters() -> Vec<Box<dyn FormatAdapter>> {
    vec![
        // roster-json runs first: its detect is the most specific (the
        // canonical source.format + game_version + diagnostics envelope), so
        // a 40kdc-native export is never mis-detected by a looser matcher.
        Box::new(RosterJsonAdapter),
        Box::new(RosterizerAdapter),
        Box::new(NewRecruitJsonAdapter),
        Box::new(GwAdapter),
        Box::new(NewRecruitWtcFullAdapter),
        Box::new(NewRecruitWtcCompactAdapter),
        Box::new(NewRecruitSimpleAdapter),
        // listforge-text requires the `name - faction - detachment (N Points)`
        // first line none of the others accept; it runs right before the
        // listforge (JSON) adapter, mirroring the TS ADAPTERS order.
        Box::new(ListForgeTextAdapter),
        // Fallback for bullet-bearing plain text without a summary fence (GW app
        // export, NewRecruit copy-text, `##` markdown lists). Placed after the
        // framed text adapters so they win when their headers are present.
        Box::new(GwHeaderlessAdapter),
        Box::new(ListForgeAdapter),
    ]
}

/// Import a ListForge army-list export into a resolved 40kdc [`Roster`].
///
/// `input` may be a full ListForge URL, a bare base64 segment, or an
/// already-decoded JSON string — all are handled transparently.
#[cfg(feature = "import")]
pub fn import_listforge(input: &str, ds: &Dataset) -> Result<Roster, ImportError> {
    let decoded = decode_listforge(input)?;
    import_roster(&decoded, ds)
}

/// Import an already-decoded payload. Selects the matching format adapter and
/// resolves the result against the dataset.
///
/// Accepts either a parsed JSON tree (NewRecruit JSON, ListForge) or
/// [`serde_json::Value::String`] wrapping raw text (the three NewRecruit
/// text formats). Most callers will use [`import_roster_text`] for the
/// string case.
#[cfg(feature = "import")]
pub fn import_roster(decoded: &serde_json::Value, ds: &Dataset) -> Result<Roster, ImportError> {
    let registry = adapters();
    let adapter = select_adapter(decoded, &registry)?;
    let parsed = adapter.parse(decoded)?;
    Ok(resolve(&parsed, ds, adapter.format()))
}

/// Import a raw text NewRecruit export (wtc-compact, wtc-full, or simple).
/// Wraps the string as [`serde_json::Value::String`] and dispatches through
/// the normal adapter registry.
#[cfg(feature = "import")]
pub fn import_roster_text(input: &str, ds: &Dataset) -> Result<Roster, ImportError> {
    let wrapped = serde_json::Value::String(input.to_string());
    import_roster(&wrapped, ds)
}

// ---------------------------------------------------------------------------
// try_import_roster — single string-in, structured-result-out entry point.
// Rust mirror of the TS `tryImportRoster` function.
// ---------------------------------------------------------------------------

/// Why a [`try_import_roster`] call did not produce a roster.
#[cfg(feature = "import")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportFailureReason {
    EmptyInput,
    DecodeFailed,
    NoAdapterMatched,
    /// A matched adapter's `parse()` threw — matcher contract violation.
    ParseFailed,
}

/// Per-adapter outcome from a [`try_import_roster`] dispatch.
#[cfg(feature = "import")]
#[derive(Debug, Clone)]
pub struct AdapterTrial {
    pub id: RosterFormat,
    /// True iff this adapter's `detect()` predicate accepted the decoded input.
    pub matched: bool,
    /// Present when `matched` is true and `parse()` then errored — the matcher
    /// violated its contract. None for clean rejections.
    pub reason: Option<String>,
}

/// Discriminated result returned by [`try_import_roster`].
#[cfg(feature = "import")]
#[derive(Debug)]
pub enum ImportResult {
    Ok {
        roster: Roster,
        format: RosterFormat,
    },
    Err {
        reason: ImportFailureReason,
        message: String,
        trials: Vec<AdapterTrial>,
    },
}

/// Cheap predicate: does the input look like ListForge's URL-or-base64 wrapper?
#[cfg(feature = "import")]
fn looks_like_listforge_encoded(input: &str) -> bool {
    if input.contains("/listforge/") {
        return true;
    }
    let lower = input
        .get(..8)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return true;
    }
    // Every gzip-then-base64 payload starts with this prefix.
    input.starts_with("H4sIA")
}

/// Auto-detect and import any supported roster format from a single string.
///
/// Pipeline:
/// 1. Empty input → `EmptyInput`.
/// 2. Looks like a ListForge URL/base64 → decode (base64 + gunzip + JSON parse).
/// 3. Looks like raw JSON → parse with `serde_json`.
/// 4. Otherwise treat as text (wrapped as [`serde_json::Value::String`]).
/// 5. Greedy first-match adapter dispatch. The first adapter whose `detect()`
///    accepts the decoded value wins; subsequent adapters are not tried.
/// 6. If the matched adapter's `parse()` errors, that's a matcher contract
///    violation — surfaced as `ParseFailed`, not silently retried.
///
/// Caller never sees an exception; the [`ImportResult`] enum carries either
/// the resolved [`Roster`] (with the detected [`RosterFormat`]) or a typed
/// failure plus per-adapter trial info for diagnostics. Mirror of TS
/// `tryImportRoster`.
#[cfg(feature = "import")]
pub fn try_import_roster(input: &str, ds: &Dataset) -> ImportResult {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return ImportResult::Err {
            reason: ImportFailureReason::EmptyInput,
            message: "input is empty".to_string(),
            trials: Vec::new(),
        };
    }

    let decoded: serde_json::Value = if looks_like_listforge_encoded(trimmed) {
        match decode_listforge(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let message = e.to_string();
                return ImportResult::Err {
                    reason: ImportFailureReason::DecodeFailed,
                    message: format!("failed to decode ListForge payload: {message}"),
                    trials: vec![AdapterTrial {
                        id: RosterFormat::Listforge,
                        matched: false,
                        reason: Some(message),
                    }],
                };
            }
        }
    } else if trimmed.starts_with('{') || trimmed.starts_with('[') {
        match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                return ImportResult::Err {
                    reason: ImportFailureReason::DecodeFailed,
                    message: format!("input looks like JSON but failed to parse: {e}"),
                    trials: Vec::new(),
                };
            }
        }
    } else {
        serde_json::Value::String(input.to_string())
    };

    let registry = adapters();
    let mut trials: Vec<AdapterTrial> = Vec::new();
    for adapter in registry.iter() {
        if !adapter.detect(&decoded) {
            trials.push(AdapterTrial {
                id: adapter.format(),
                matched: false,
                reason: None,
            });
            continue;
        }
        // Greedy first-match: matched adapter must parse cleanly.
        match adapter.parse(&decoded) {
            Ok(parsed) => {
                let roster = resolve(&parsed, ds, adapter.format());
                return ImportResult::Ok {
                    roster,
                    format: adapter.format(),
                };
            }
            Err(e) => {
                let message = e.to_string();
                let id = adapter.format();
                trials.push(AdapterTrial {
                    id,
                    matched: true,
                    reason: Some(message.clone()),
                });
                return ImportResult::Err {
                    reason: ImportFailureReason::ParseFailed,
                    message: format!("{}: {message}", crate::import::format_id(id)),
                    trials,
                };
            }
        }
    }

    let count = trials.len();
    ImportResult::Err {
        reason: ImportFailureReason::NoAdapterMatched,
        message: format!("tried {count} formats, none recognised the input"),
        trials,
    }
}
