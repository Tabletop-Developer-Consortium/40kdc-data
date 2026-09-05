from pathlib import Path

p = Path('crates/wh40kdc/src/translate/effect.rs')
text = p.read_text()
old = '''        EffectNode::SingleEffect(_)
        | EffectNode::MovementModifierEffect(_)
        | EffectNode::AuraEffect(_) => {'''
new = '''        EffectNode::NoEffectEffect(_)
        | EffectNode::SingleEffect(_)
        | EffectNode::MovementModifierEffect(_)
        | EffectNode::AuraEffect(_) => {'''
assert text.count(old) == 1, 'Expected the exhaustive block renderer leaf arm'
p.write_text(text.replace(old, new))

p = Path('docs/grey-knights-dsl-fidelity-2026-09-04.md')
text = p.read_text()
start = text.index('Source locators (not reproduced rule paragraphs):')
end = text.index('## Mechanical claim ledger')
text = text[:start] + '''Current-source verification (no raw rule paragraphs are committed):

The current MFM snapshot was downloaded using the repository's configured source
on 2026-09-05 UTC (2026-09-04 in America/New_York). Its metadata data_version is
946; its SHA-256 is
`83d4e88119d0756dbbfb4267c602421397f22d5807ff1521aa8139744623db7c`.
The following are exact `datasheet_ability.id` values, verified through the
`datasheet_datasheet_ability` joins, not inferred from enrichment `unit_ids`:

| Current datasheet | Ability | Source record id |
| --- | --- | --- |
| Grand Master Voldus | Sanctuary | `7911d9a1-f1a1-4cbb-9904-d357e491ba53` |
| Grand Master | Warrior Strategist | `5c85c7d8-0607-4e29-a4b5-6ab93d4e36c0` |
| Grand Master in Nemesis Dreadknight | Warrior Strategist | `8675a6bd-8857-4b03-b268-028766c6631b` |
| Interceptor Squad | Personal Teleporters | `38b2ec18-c15d-4142-b5a5-f25df0cfbbb0` |
| Venerable Dreadnought | Guidance of the Ancients | `b45355c5-7cfa-4792-b7ee-826e06fe07f4` |

Sanctuary has unit Stealth and the incoming melee Hit penalty without a leading
condition. Both Grand Master datasheets have Warrior Strategist. The active
Grey Knights Venerable Dreadnought (`78b4d75e-14f6-4116-8fb5-8ef2b34d361b`)
references Guidance, not Wisdom. Historical/Legends rules and append-only share
registry slots are not evidence that Wisdom belongs on this active datasheet.

Personal Teleporters still has the post-shooting movement permission without an
explicit Deep Strike exclusion sentence. The same-turn exclusion follows core
20.04 (no further movement after ingress until the next Charge phase), together
with 24.09 (Deep Strike is an ingress method). These numbered rules were checked
at `https://www.40k.app/rules/20-strategic-reserves` and
`https://www.40k.app/rules/24-core-abilities`. These are corroborating rules
mirrors, not independent rule authorities. The implementation does not falsely
attribute an errata sentence to the datasheet or copy Echojump into it.

The supplied Prescient Redeployment wording is retained as the source for its
unresolved historical quota/eligibility mechanism. No current-source assumption
is used to flatten that mechanism into an unconditional redeployment.

''' + text[end:]
p.write_text(text)
