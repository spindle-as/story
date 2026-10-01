import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR, ROOT } from './paths.ts';

/**
 * Copies bundled example projects into the projects directory, once each. Deleting a
 * seeded example keeps it deleted. An example's "codebase" is stored relative to the app root.
 */
export async function seedExamples() {
  const marker = path.join(PROJECTS_DIR, '.seeded.json');
  let seeded: string[] = [];
  try {
    seeded = JSON.parse(await fsp.readFile(marker, 'utf8'));
  } catch {}
  const examples = path.join(ROOT, 'examples');
  for (const entry of await fsp.readdir(examples, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || seeded.includes(entry.name)) continue;
    seeded.push(entry.name);
    const target = path.join(PROJECTS_DIR, entry.name);
    try {
      await fsp.access(target);
      continue;
    } catch {}
    await fsp.cp(path.join(examples, entry.name), target, { recursive: true });
    const configFile = path.join(target, 'project.json');
    const config = JSON.parse(await fsp.readFile(configFile, 'utf8'));
    config.codebase = path.resolve(ROOT, config.codebase);
    await fsp.writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
  }
  await fsp.writeFile(marker, JSON.stringify(seeded));
}
