/**
 * Find enrichment conditions and effects that reference things the dataset does not define.
 *
 * Two classes exist today and neither is caught by schema validation, because both are
 * well-formed strings in the right place — they are only wrong relative to the rest of
 * the data:
 *
 *   - `target-has-keyword` naming a keyword no unit has. A gate on a keyword nothing
 *     carries never fires, so the effect is silently dead.
 *   - `stratagem` naming an id no stratagem file defines, so the effect points at nothing.
 *
 * Exit 1 when any are found, so CI can keep the count at zero once they are resolved.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** repo root, so the audit runs from anywhere (other audits assume cwd; this one should not) */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string, leaf: string): string[] {
  return readdirSync(dir).flatMap((e: string) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p, leaf) : p.endsWith(leaf) ? [p] : [];
  });
}
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** keywords are written in varying case and spacing across sources; compare normalised */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const keywords = new Set<string>();
for (const f of walk(join(ROOT, 'data/core'), 'units.json'))
  for (const u of read(f) as Array<{ keywords?: string[] }>)
    for (const k of u.keywords ?? []) keywords.add(norm(k));
/** weapon keywords (Sustained Hits, Twin-linked, Cleave X) are a separate vocabulary */
for (const f of walk(join(ROOT, 'data/core'), 'weapon-keywords.json'))
  for (const k of read(f) as Array<{ id?: string; name?: string }>) {
    if (k.id) keywords.add(norm(k.id));
    if (k.name) keywords.add(norm(k.name));
  }

const stratagems = new Set<string>();
for (const f of walk(join(ROOT, 'data/core'), 'stratagems.json'))
  for (const s of read(f) as Array<{ id?: string }>) if (s.id) stratagems.add(s.id);

const bad: Array<{ file: string; id: string; kind: string; ref: string }> = [];
for (const f of walk(join(ROOT, 'data/enrichment'), 'abilities.json')) {
  for (const a of read(f) as Array<Record<string, unknown>>) {
    const blob = JSON.stringify(a.effect ?? {});
    for (const m of blob.matchAll(/"keyword":\s*"([^"]+)"/g))
      if (!keywords.has(norm(m[1])) && !keywords.has(norm(m[1].replace(/\s+\d+$/, '')))) bad.push({ file: f.replace(ROOT + '/', ''), id: String(a.ability_id), kind: 'keyword', ref: m[1] });
    for (const m of blob.matchAll(/"stratagem(?:_id)?":\s*"([^"]+)"/g))
      if (!stratagems.has(m[1])) bad.push({ file: f.replace(ROOT + '/', ''), id: String(a.ability_id), kind: 'stratagem', ref: m[1] });
  }
}
const byRef = new Map<string, number>();
for (const b of bad) byRef.set(`${b.kind} ${JSON.stringify(b.ref)}`, (byRef.get(`${b.kind} ${JSON.stringify(b.ref)}`) ?? 0) + 1);
for (const b of bad) console.log(`${b.kind.padEnd(10)} ${JSON.stringify(b.ref).padEnd(28)} ${b.id}`);
console.log(`\nknown keywords ${keywords.size}; known stratagems ${stratagems.size}`);
console.log(`dangling references: ${bad.length}`);
for (const [k, n] of [...byRef].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${k}`);
process.exit(bad.length ? 1 : 0);
