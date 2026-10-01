import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  beatGrid,
  compileScore,
  composeScore,
  cutAlignment,
  INSTRUMENTS,
  MOODS,
  SCALES,
  SFX,
  type Mood,
  type Score,
  type ScoreSfx,
} from '../shared/score.ts';
import type { Project } from '../shared/types.ts';
import { emit } from './events.ts';
import { HttpError, projectDir, sceneFile } from './paths.ts';
import { getProject, readConfig, snapshot, writeConfig } from './projects.ts';
import { collectCues, synthesize, type SceneCue } from './renderer.ts';

export const SCORE_AUDIO = 'assets/audio/score.wav';
const scoreFile = (slug: string) => path.join(projectDir(slug), 'score.json');

export async function readScoreText(slug: string): Promise<string | null> {
  return fsp.readFile(scoreFile(slug), 'utf8').catch(() => null);
}

function parseScore(text: string): Score {
  let score: Score;
  try {
    score = JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, `score.json is not valid JSON: ${(e as Error).message}`);
  }
  const problems: string[] = [];
  if (!(score.bpm >= 30 && score.bpm <= 240)) problems.push('"bpm" must be a number between 30 and 240');
  if (typeof score.key !== 'string') problems.push('"key" must be a note name like "D" or "F#"');
  if (!(score.scale in SCALES)) problems.push(`"scale" must be one of ${Object.keys(SCALES).join(', ')}`);
  if (!Array.isArray(score.chords) || !score.chords.length) problems.push('"chords" must be a non-empty list like ["I", "V", "vi", "IV"]');
  if (!Array.isArray(score.tracks)) problems.push('"tracks" must be a list');
  if (problems.length) throw new HttpError(400, `score.json: ${problems.join('; ')}`);
  return score;
}

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Changes whenever the score or anything that affects its timing (scene files) changes. */
function sourceHash(project: Project, scoreText: string) {
  return hash(scoreText + project.scenes.map((s) => `${s.id}:${s.version}:${s.duration}`).join('|'));
}

/** Scene cues (in scene time) → sound effects in video time. */
export function sceneSounds(scenes: Awaited<ReturnType<typeof collectCues>>['scenes'], warnings: string[]): ScoreSfx[] {
  const out: ScoreSfx[] = [];
  for (const scene of scenes) {
    for (const cue of scene.cues as SceneCue[]) {
      const t = scene.start + cue.t;
      if (cue.source === 'helper') {
        if (cue.type === 'click') out.push({ t, type: 'click', gain: 0.4 });
        else if (cue.type === 'typing') out.push({ t, type: 'typing', d: cue.d, chars: cue.chars, gain: 0.28 });
        continue;
      }
      if (!(SFX as readonly string[]).includes(cue.type)) {
        warnings.push(`Scene "${scene.id}" asks for unknown sound "${cue.type}" at ${cue.t}s. Use one of: ${SFX.join(', ')}`);
        continue;
      }
      out.push({ t, type: cue.type as ScoreSfx['type'], d: cue.d, gain: cue.gain, pan: cue.pan, chars: cue.chars });
    }
  }
  return out;
}

const running = new Map<string, Promise<RenderResult>>();

export interface RenderResult {
  summary: string;
  warnings: string[];
}

/** Renders score.json to assets/audio/score.wav and makes it the project's audio track. */
export function renderScore(slug: string): Promise<RenderResult> {
  const previous = running.get(slug) ?? Promise.resolve(null);
  const job = previous
    .catch(() => null)
    .then(() => doRender(slug))
    .finally(() => {
      if (running.get(slug) === job) running.delete(slug);
    });
  running.set(slug, job);
  return job;
}

async function doRender(slug: string): Promise<RenderResult> {
  emit({ type: 'score', project: slug, status: 'rendering' });
  try {
    const text = await readScoreText(slug);
    if (text === null) throw new HttpError(404, 'This project has no score.json yet. Generate one first.');
    const score = parseScore(text);
    const project = await getProject(slug);
    if (!project.scenes.length) throw new HttpError(400, 'Add scenes before rendering a soundtrack.');

    const warnings: string[] = [];
    const cues = await collectCues(slug);
    for (const s of cues.scenes) if (s.error) warnings.push(`Scene "${s.id}" failed to load, its sounds were skipped: ${s.error}`);
    // Sound design (clicks, typing, Story.sound cues) is mixed separately; the score is music only.
    const sceneSfx: ScoreSfx[] = [];
    const compiled = compileScore(score, { duration: cues.duration, sceneSfx });
    warnings.push(...compiled.warnings);

    const out = await synthesize(compiled.events, { duration: cues.duration, master: score.master });
    warnings.push(...out.errors.map((e) => `Synth: ${e}`));
    const file = path.join(projectDir(slug), SCORE_AUDIO);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, out.wav);

    const config = await readConfig(slug);
    config.audio = {
      file: SCORE_AUDIO,
      name: `Generated score (${score.mood ?? 'custom'})`,
      duration: cues.duration,
      offset: 0,
      bpm: score.bpm,
      beats: compiled.beats,
      downbeats: compiled.downbeats,
      generated: true,
      provider: 'synth',
      sourceHash: sourceHash(project, text),
      version: Date.now(),
      key: `${score.key} ${score.scale}`,
      mood: score.mood,
    };
    await writeConfig(slug, config);

    const notes = compiled.events.filter((e) => e.kind === 'note').length;
    const sfx = compiled.events.filter((e) => e.kind === 'sfx').length;
    const alignment = cutAlignment(cues.cuts, score.bpm, score.offset ?? 0);
    const summary = [
      `Rendered ${SCORE_AUDIO}: ${cues.duration.toFixed(2)}s at ${score.bpm} BPM in ${score.key} ${score.scale}, ${compiled.totalBars} bars, ${score.tracks.length} tracks, ${notes} notes${sfx ? `, ${sfx} musical effects` : ''}.`,
      alignment.length
        ? `Cuts vs beats: ${alignment.map((a, i) => `${cues.scenes[i].id}→${cues.scenes[i + 1].id} at ${a.t.toFixed(2)}s is ${a.ms === 0 ? 'on' : `${a.ms > 0 ? '+' : ''}${a.ms}ms from`} beat ${a.beat}`).join('; ')}.`
        : '',
      `Level: peak ${out.peakDb.toFixed(1)} dBFS before normalising to -1 dBFS (${out.gainDb >= 0 ? '+' : ''}${out.gainDb.toFixed(1)} dB), loudness ~${out.rmsDb.toFixed(1)} dB RMS.`,
    ].filter(Boolean).join('\n');

    emit({ type: 'project', project: slug });
    emit({ type: 'score', project: slug, status: 'done', message: summary });
    return { summary, warnings };
  } catch (e) {
    emit({ type: 'score', project: slug, status: 'error', message: (e as Error).message });
    throw e;
  }
}

/** Writes a fresh score.json composed around the current scenes, then renders it. */
export async function composeAndRender(slug: string, input: { mood?: Mood; bpm?: number; key?: string; sfx?: boolean }) {
  const mood = input.mood && input.mood in MOODS ? input.mood : 'minimal';
  const project = await getProject(slug);
  let acc = 0;
  const cuts = project.scenes.slice(0, -1).map((s) => (acc += s.duration));
  const score = composeScore({
    cuts,
    duration: acc + (project.scenes.at(-1)?.duration ?? 0),
    mood,
    bpm: input.bpm && input.bpm >= 30 && input.bpm <= 240 ? input.bpm : undefined,
    key: input.key || undefined,
    sfx: input.sfx,
  });
  await writeScoreText(slug, JSON.stringify(score, null, 2) + '\n');
  return renderScore(slug);
}

/** Set while we write score.json ourselves, so the file watcher doesn't render it a second time. */
export const selfWrites = new Set<string>();

async function writeScoreText(slug: string, text: string) {
  selfWrites.add(slug);
  await fsp.writeFile(scoreFile(slug), text);
  setTimeout(() => selfWrites.delete(slug), 1000);
}

/** Re-renders a generated soundtrack when the score or the scenes changed since it was rendered. */
export async function ensureFreshScore(slug: string) {
  const project = await getProject(slug);
  if (!project.audio?.generated || project.audio.provider === 'elevenlabs') return false;
  const text = await readScoreText(slug);
  if (text === null || project.audio.sourceHash === sourceHash(project, text)) return false;
  await renderScore(slug);
  return true;
}

export async function scoreStatus(slug: string) {
  const project = await getProject(slug);
  const text = await readScoreText(slug);
  let cuts: { t: number; beat: number; ms: number }[] = [];
  let score: Score | null = null;
  let error: string | null = null;
  if (text) {
    try {
      score = parseScore(text);
      let acc = 0;
      cuts = cutAlignment(project.scenes.slice(0, -1).map((s) => (acc += s.duration)), score.bpm, score.offset ?? 0);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return {
    score,
    error,
    cuts,
    stale: !!(project.audio?.generated && text && project.audio.sourceHash !== sourceHash(project, text)),
    rendering: running.has(slug),
    moods: Object.entries(MOODS).map(([id, m]) => ({ id, label: m.label, description: m.description, bpm: m.bpm, key: m.key, scale: m.scale })),
    instruments: INSTRUMENTS,
    sfx: SFX,
  };
}

/**
 * Nudges scene durations so every cut lands exactly on a beat of the current soundtrack (detected
 * beats for music, the score's grid for the synth). A scene never gets shorter than its own
 * timeline, so no animation is cut off.
 */
export async function snapScenesToBeat(slug: string) {
  const project = await getProject(slug);
  const total = project.scenes.reduce((s, x) => s + x.duration, 0);
  let beats: number[] = [];
  if (project.audio?.beats.length) {
    beats = project.audio.beats.map((b) => b - (project.audio!.offset || 0)).filter((b) => b >= 0);
  } else {
    const text = await readScoreText(slug);
    if (!text) throw new HttpError(400, 'Add a soundtrack first; snapping needs its beats.');
    beats = beatGrid(parseScore(text), total + 10).beats;
  }
  if (beats.length < 2) throw new HttpError(400, 'The soundtrack has no detectable beat.');
  const cues = await collectCues(slug);
  const changes: { scene: string; from: number; to: number }[] = [];
  let start = 0;
  for (const [i, scene] of cues.scenes.entries()) {
    if (i === cues.scenes.length - 1) break;
    const minimum = Math.max(0.5, scene.timeline) - 1e-6;
    const end = start + scene.duration;
    const candidates = beats.filter((b) => b - start >= minimum);
    if (!candidates.length) break;
    const target = candidates.reduce((best, b) => (Math.abs(b - end) < Math.abs(best - end) ? b : best));
    const duration = Number((target - start).toFixed(3));
    if (Math.abs(duration - scene.duration) > 0.0005) {
      const file = sceneFile(slug, scene.id);
      const html = await fsp.readFile(file, 'utf8');
      const next = html.replace(/(<meta\s+name=["']story:duration["']\s+content=["'])[^"']*(["'])/i, `$1${duration}$2`);
      if (next !== html) {
        await snapshot(slug, scene.id, 'Before snapping to the beat');
        await fsp.writeFile(file, next);
        changes.push({ scene: scene.id, from: scene.duration, to: duration });
      }
    }
    start = Number((start + duration).toFixed(3));
  }
  return changes;
}
