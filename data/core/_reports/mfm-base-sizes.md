# MFM base sizes — APPLIED

Reconciles unit `base_size_mm` from the dump's datasheet baseSize label,
confident round/oval strings only (Hull/Flying/Unique, per-model, and
ambiguous ovals are skipped — authored values kept). A dump value is
authoritative (draft:false); non-draft authored disagreements are surfaced,
never overwritten.

| Metric | Count |
|---|--:|
| Filled (was empty) | 0 |
| De-drafted (dump confirmed a guess) | 0 |
| Corrected (dump fixed a draft) | 0 |
| Confirmed (already matched) | 863 |
| Review (authored ≠ dump, kept) | 12 |

## Review — authored value the dump contradicts (NOT changed)

- adeptus-astartes/vulkan-hestan: authored round 32 vs dump round 40
- adeptus-astartes/darnath-lysander: authored round 40 vs dump round 50
- aeldari/ynnari-archon: authored round 25 vs dump round 32
- aeldari/yvraine: authored oval 75x42 vs dump oval 74x42
- agents-of-the-imperium/voidsmen-at-arms: authored round 32 vs dump round 25
- astra-militarum/attilan-rough-riders: authored oval 60x35.5 vs dump oval 60x35
- chaos-space-marines/huron-blackheart: authored round 32 vs dump round 50
- chaos-space-marines/sorcerer: authored round 32 vs dump round 40
- drukhari/archon: authored round 25 vs dump round 32
- emperors-children/sorcerer: authored round 32 vs dump round 40
- grey-knights/brotherhood-techmarine: authored round 32 vs dump round 40
- necrons/ctan-shard-of-the-nightbringer: authored round 40 vs dump round 90

