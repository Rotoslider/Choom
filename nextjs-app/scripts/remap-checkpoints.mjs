#!/usr/bin/env node
// Re-point per-Choom image checkpoints at whatever Forge currently calls them.
//
// Forge builds a checkpoint's `title` from its path relative to the models
// directory, so "Flux/flux_dev.safetensors [2eda627c8a]" and
// "flux_dev.safetensors [2eda627c8a]" are the same file in two folder layouts.
// Move Forge to another host, reorganise the models folder, or reinstall via a
// different launcher, and every stored title stops matching. The Settings
// dropdowns then render blank — the value is still there, it just is not in the
// option list any more — which reads as "my settings were lost".
//
// The trailing [hash] is stable across all of that, so remap on it.
//
//   node scripts/remap-checkpoints.mjs                          # dry run
//   node scripts/remap-checkpoints.mjs --write                  # apply
//   node scripts/remap-checkpoints.mjs --endpoint http://host:7860 --write
//
// Stop the dev server before --write: it holds dev.db open.

import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const write = args.includes('--write');
const epIdx = args.indexOf('--endpoint');
const endpoint = epIdx >= 0 ? args[epIdx + 1]
  : process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860';

const prisma = new PrismaClient();
const hashOf = (title) => {
  const m = /\[([0-9a-f]+)\]\s*$/i.exec(title || '');
  return m ? m[1].toLowerCase() : null;
};

const res = await fetch(`${endpoint}/sdapi/v1/sd-models`);
if (!res.ok) {
  console.error(`Forge unreachable at ${endpoint} (HTTP ${res.status})`);
  process.exit(1);
}
const models = await res.json();
const titles = new Set(models.map((m) => m.title));
const byHash = new Map();
for (const m of models) {
  const h = hashOf(m.title);
  if (h) byHash.set(h, m.title);
}
console.log(`Forge at ${endpoint}: ${models.length} checkpoints\n`);

let changed = 0;
for (const choom of await prisma.choom.findMany({ where: { imageSettings: { not: null } } })) {
  let settings;
  try { settings = JSON.parse(choom.imageSettings); } catch { continue; }
  let dirty = false;
  for (const [mode, cfg] of Object.entries(settings)) {
    const ck = cfg?.checkpoint;
    if (!ck || titles.has(ck)) continue;          // already valid
    const target = byHash.get(hashOf(ck));
    if (!target) {
      console.log(`  ${choom.name}/${mode}: NO MATCH for ${ck} — set it by hand`);
      continue;
    }
    console.log(`  ${choom.name}/${mode}:\n      ${ck}\n   -> ${target}`);
    cfg.checkpoint = target;
    dirty = true;
  }
  if (dirty) {
    changed++;
    if (write) {
      await prisma.choom.update({
        where: { id: choom.id },
        data: { imageSettings: JSON.stringify(settings) },
      });
    }
  }
}

console.log(changed === 0
  ? '\nAll checkpoints already resolve — nothing to do.'
  : `\n${write ? 'Updated' : 'Would update'} ${changed} Choom(s).` + (write ? '' : ' Re-run with --write to apply.'));
await prisma.$disconnect();
