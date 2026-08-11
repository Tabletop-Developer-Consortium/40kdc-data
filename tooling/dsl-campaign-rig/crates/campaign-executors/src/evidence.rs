use std::collections::BTreeSet;

use campaign_domain::Hash256;
use serde::{Deserialize, Serialize};

use crate::ExecutorError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClauseClassification {
    Mechanical,
    Nonmechanical,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceClause {
    pub id: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub classification: ClauseClassification,
    pub slice_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidencePacket {
    pub source_hash: Hash256,
    pub source_utf16_len: usize,
    pub clauses: Vec<EvidenceClause>,
}

pub fn validate_evidence_packet(
    source: &str,
    packet: &EvidencePacket,
) -> Result<(), ExecutorError> {
    if packet.source_hash != Hash256::digest(source.as_bytes())
        || packet.source_utf16_len != source.encode_utf16().count()
        || packet.clauses.is_empty()
    {
        return Err(ExecutorError::InvalidEvidence);
    }
    let mut expected_start = 0;
    let mut ids = BTreeSet::new();
    for clause in &packet.clauses {
        if clause.start_utf16 != expected_start
            || clause.end_utf16 <= clause.start_utf16
            || clause.end_utf16 > packet.source_utf16_len
            || !ids.insert(&clause.id)
        {
            return Err(ExecutorError::InvalidEvidence);
        }
        let slice = utf16_slice(source, clause.start_utf16, clause.end_utf16)?;
        if Hash256::digest(slice.as_bytes()) != clause.slice_hash {
            return Err(ExecutorError::InvalidEvidence);
        }
        expected_start = clause.end_utf16;
    }
    if expected_start != packet.source_utf16_len {
        return Err(ExecutorError::InvalidEvidence);
    }
    Ok(())
}

fn utf16_slice(source: &str, start: usize, end: usize) -> Result<&str, ExecutorError> {
    let mut utf16_offset = 0;
    let mut byte_start = None;
    let mut byte_end = None;
    for (byte_offset, character) in source.char_indices() {
        if utf16_offset == start {
            byte_start = Some(byte_offset);
        }
        if utf16_offset == end {
            byte_end = Some(byte_offset);
            break;
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > start && byte_start.is_none() || utf16_offset > end {
            return Err(ExecutorError::InvalidEvidence);
        }
    }
    if utf16_offset == start && byte_start.is_none() {
        byte_start = Some(source.len());
    }
    if end == source.encode_utf16().count() {
        byte_end = Some(source.len());
    }
    source
        .get(
            byte_start.ok_or(ExecutorError::InvalidEvidence)?
                ..byte_end.ok_or(ExecutorError::InvalidEvidence)?,
        )
        .ok_or(ExecutorError::InvalidEvidence)
}
