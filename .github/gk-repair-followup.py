from pathlib import Path
import json

# Prefer explicit bounded cardinality for required selections.
p = Path('data/enrichment/grey-knights/abilities.json')
abilities = json.loads(p.read_text())
for entry in abilities:
    if entry['ability_id'] in {'hammer-aflame-psychic', 'righteous-persecution', 'litanies-of-sanctity'}:
        selector = entry['effect']['selector']
        selector.pop('count', None)
        selector['min_count'] = 1
        selector['max_count'] = 1
p.write_text(json.dumps(abilities, ensure_ascii=False, indent=2) + '\n')

# Expose the Deep Strike case of the existing ingress-history predicate.
for name in [
    'tools/src/translate/condition.ts',
    'crates/wh40kdc/src/translate/mod.rs',
    'python/src/wh40kdc/translate/condition.py',
    'go/translate_condition.go',
]:
    p = Path(name)
    text = p.read_text()
    old = 'the unit made an ingress move this turn'
    new = 'the unit made an ingress move (including a Deep Strike setup) this turn'
    assert old in text or new in text, name
    p.write_text(text.replace(old, new))

p = Path('tools/test/grey-knights-fidelity.test.ts')
text = p.read_text()
text = text.replace('"not (the unit made an ingress move this turn)"', '"not (the unit made an ingress move (including a Deep Strike setup) this turn)"')
text += '''

describe("Grey Knights selection cardinality", () => {
  for (const id of ["hammer-aflame-psychic", "righteous-persecution", "litanies-of-sanctity"]) {
    it(`${id} requires exactly one target once activated`, () => {
      const selector = (ability(id).effect as unknown as { selector: Record<string, unknown> }).selector;
      expect(selector).toMatchObject({ min_count: 1, max_count: 1 });
      expect(selector.count).toBeUndefined();
    });
  }
});
'''
p.write_text(text)

p = Path('docs/grey-knights-dsl-fidelity-2026-09-04.md')
text = p.read_text()
text = text.replace('`40k.app` current datasheets and the numbered 11e core rules were checked', 'The current MFM snapshot (version 946, retrieved 2026-09-05 UTC) was checked directly, and `40k.app` current datasheets and the numbered 11e core rules were checked')
text = text.replace('These are corroborating mirrors of the same game rules, not independent witnesses.', 'The MFM snapshot is the current structured source; these public pages are corroborating mirrors of the same game rules, not independent witnesses. Its Sanctuary record is `ed3e0117-7cc4-40ba-99b1-81214859f748`; Warrior Strategist is `869d3ffc-71c1-42a0-9c65-99d1a2865f27`, joined to both Grand Master datasheets; Personal Teleporters is `af1d2b93-4a43-4a22-8ba0-f038d26635bc`. The Grey Knights Venerable Dreadnought datasheet `2546f875-62df-48b7-b91e-6bd4cdf5805e` has Guidance and Fervour, not Wisdom.')
text = text.replace('Focused source-clause assertions for all 23 repaired entries;', 'Focused source-clause assertions for all 23 repaired entries; explicit exact-one cardinality checks for Hammer, Righteous Persecution, and Litanies;')
p.write_text(text)
