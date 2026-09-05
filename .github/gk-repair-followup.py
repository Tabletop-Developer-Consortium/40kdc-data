from pathlib import Path
import json
import runpy

p = Path('data/enrichment/grey-knights/abilities.json')
abilities = json.loads(p.read_text())
for entry in abilities:
    if entry['ability_id'] in {'hammer-aflame-psychic', 'righteous-persecution', 'litanies-of-sanctity'}:
        selector = entry['effect']['selector']
        selector.pop('count', None)
        selector['min_count'] = 1
        selector['max_count'] = 1
p.write_text(json.dumps(abilities, ensure_ascii=False, indent=2) + '\n')

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
text = p.read_text().replace('"not (the unit made an ingress move this turn)"', '"not (the unit made an ingress move (including a Deep Strike setup) this turn)"')
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

runpy.run_path('.github/gk-repair-finalize.py')
