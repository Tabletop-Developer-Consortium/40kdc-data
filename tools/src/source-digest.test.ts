import { describe, expect, it } from 'vitest';
import { digestMatches, normaliseSourceText, sourceDigest } from './source-digest.js';

describe('source digest', () => {
  it('ignores reprint noise that carries no meaning', async () => {
    const a = 'Each time this model makes an attack, add 1 to the Hit roll.';
    const b = '  each   time this model makes an attack,\nadd 1 to the Hit roll ';
    expect(normaliseSourceText(a)).toBe(normaliseSourceText(b));
    expect(await sourceDigest(a)).toBe(await sourceDigest(b));
  });

  it('changes when a number changes — the case that invalidates an annotation', async () => {
    const before = 'This model has a 4+ invulnerable save.';
    const after = 'This model has a 5+ invulnerable save.';
    expect(await sourceDigest(before)).not.toBe(await sourceDigest(after));
  });

  it('changes when a condition is added, which is the common dataslate rewording', async () => {
    const before = 'Add 1 to the Hit roll.';
    const after = 'Add 1 to the Hit roll if the target is within range of an objective marker.';
    expect(await sourceDigest(before)).not.toBe(await sourceDigest(after));
  });

  it('treats curly and straight quotes alike', async () => {
    expect(await sourceDigest("the model's weapon")).toBe(await sourceDigest('the model’s weapon'));
  });

  it('digestMatches is false for an absent digest', async () => {
    expect(await digestMatches(undefined, 'anything')).toBe(false);
  });

  it('stores no source text: a digest is 64 hex chars and irreversible', async () => {
    const d = await sourceDigest('Feel No Pain 5+.');
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});
