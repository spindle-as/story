import fsp from 'node:fs/promises';
import path from 'node:path';
import { internalDir, PROJECTS_DIR } from './paths.ts';
import { readConfig, writeConfig } from './projects.ts';
import { renderScore } from './score.ts';

/**
 * Earlier versions baked sound effects into the project's audio track. Sound effects are cues
 * now (sounds.json), so point generated tracks back at the clean music:
 * - ElevenLabs: the old soundtrack.wav mix → the take's own file.
 * - Built-in synth: scores rendered before the provider field existed included scene sounds;
 *   re-render them as music only (free and offline).
 */
export async function migrateProjects() {
  const entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const slug = entry.name;
    try {
      const config = await readConfig(slug);
      const audio = config.audio;
      if (!audio?.generated) continue;
      if (audio.provider === 'elevenlabs' && audio.file === 'assets/audio/soundtrack.wav' && audio.takeId) {
        const takes = JSON.parse(await fsp.readFile(path.join(internalDir(slug), 'music-takes.json'), 'utf8'));
        const take = takes.find((t: { id: string }) => t.id === audio.takeId);
        if (take) {
          config.audio = { ...audio, file: take.file, duration: take.duration, sourceHash: undefined, version: Date.now() };
          await writeConfig(slug, config);
          console.log(`  ${slug}: music now plays the clean take; sound effects are cues in the Sound tab`);
        }
      } else if (!audio.provider) {
        await renderScore(slug);
        console.log(`  ${slug}: re-rendered the synth score without baked-in sound effects`);
      }
    } catch (e) {
      console.warn(`  ${slug}: could not migrate audio (${(e as Error).message})`);
    }
  }
}
