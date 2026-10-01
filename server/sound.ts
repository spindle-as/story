import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  emptySounds,
  resolveCues,
  withPresets,
  type SceneCueReport,
  type SoundCue,
  type SoundDef,
  type SoundsFile,
} from '../shared/sound.ts';
import type { Project } from '../shared/types.ts';
import { emit } from './events.ts';
import { assertId, HttpError, internalDir, projectDir, slugify } from './paths.ts';
import { getProject } from './projects.ts';
import { collectCues, synthesize } from './renderer.ts';
import { elevenLabsKey } from './settings.ts';
import { duckRanges, resolveLines } from '../shared/voice.ts';
import { readVoiceover, timeline as voiceTimeline } from './voice.ts';

const API = process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io/v1';
export const MIX_FILE = 'assets/audio/soundtrack.wav';
const soundsFile = (slug: string) => path.join(projectDir(slug), 'sounds.json');
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const exists = (p: string) => fsp.access(p).then(() => true, () => false);

export async function readSounds(slug: string): Promise<SoundsFile> {
  try {
    return withPresets(JSON.parse(await fsp.readFile(soundsFile(slug), 'utf8')));
  } catch {
    return emptySounds();
  }
}

export async function writeSounds(slug: string, sounds: SoundsFile) {
  await fsp.writeFile(soundsFile(slug), JSON.stringify(sounds, null, 2) + '\n');
  emit({ type: 'sounds', project: slug });
}

// ---------------------------------------------------------------------------
// Automatic cues reported by scenes, cached per scene file version.

const reportCache = new Map<string, SceneCueReport[]>();

async function sceneReports(project: Project): Promise<Record<string, SceneCueReport[]>> {
  const key = (id: string, version: number) => `${project.slug}:${id}:${version}`;
  const missing = new Set(project.scenes.filter((s) => !reportCache.has(key(s.id, s.version))).map((s) => s.id));
  if (missing.size) {
    const collected = await collectCues(project.slug, missing);
    for (const scene of collected.scenes) {
      if (!missing.has(scene.id)) continue;
      const version = project.scenes.find((s) => s.id === scene.id)!.version;
      if (!scene.error) reportCache.set(key(scene.id, version), scene.cues as SceneCueReport[]);
    }
  }
  return Object.fromEntries(project.scenes.map((s) => [s.id, reportCache.get(key(s.id, s.version)) ?? []]));
}

function timeline(project: Project) {
  let start = 0;
  return project.scenes.map((s) => {
    const entry = { id: s.id, start, duration: s.duration };
    start += s.duration;
    return entry;
  });
}

export async function soundState(slug: string) {
  const project = await getProject(slug);
  const sounds = await readSounds(slug);
  const reports = await sceneReports(project);
  const cues = resolveCues(sounds, timeline(project), reports);
  const available: Record<string, boolean> = {};
  for (const def of sounds.library) available[def.id] = !!def.file && (await exists(path.join(projectDir(slug), def.file)));
  const used = [...new Set(cues.filter((c) => !c.muted).map((c) => c.sound))];
  const { source } = await elevenLabsKey();
  return {
    sounds,
    cues,
    available,
    missing: used.filter((id) => !available[id]),
    key: { configured: !!source },
  };
}

// ---------------------------------------------------------------------------
// Library

async function requireKey() {
  const { key } = await elevenLabsKey();
  if (!key) throw new HttpError(400, 'Add your ElevenLabs API key in the Soundtrack dialog to generate sounds, or upload your own.');
  return key;
}

/** Generates (or re-generates as a new variant) a library sound with ElevenLabs Sound Effects. */
export async function generateSound(slug: string, id: string) {
  const sounds = await readSounds(slug);
  const def = sounds.library.find((s) => s.id === id);
  if (!def) throw new HttpError(404, `No sound "${id}" in the library`);
  if (!def.prompt) throw new HttpError(400, `"${def.label}" is an uploaded sound; upload a new file to replace it.`);
  const key = await requireKey();
  emit({ type: 'score', project: slug, status: 'rendering', message: `Generating “${def.label}”…` });
  const res = await fetch(`${API}/sound-generation?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: def.prompt, duration_seconds: Math.min(30, Math.max(0.5, def.seconds ?? 1)), prompt_influence: 0.6 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body: any = await res.json();
      detail = body?.detail?.message ?? body?.detail ?? detail;
    } catch {}
    emit({ type: 'score', project: slug, status: 'error', message: `ElevenLabs: ${detail}` });
    throw new HttpError(502, `ElevenLabs: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  const variant = (def.variant ?? 0) + 1;
  const file = `assets/audio/sfx/${id}-v${variant}.mp3`;
  await fsp.mkdir(path.join(projectDir(slug), 'assets/audio/sfx'), { recursive: true });
  await fsp.writeFile(path.join(projectDir(slug), file), Buffer.from(await res.arrayBuffer()));
  def.file = file;
  def.variant = variant;
  await writeSounds(slug, sounds);
  emit({ type: 'score', project: slug, status: 'done', message: `Generated “${def.label}”` });
  return def;
}

/** Generates every sound that cues use but that has no recording yet. */
export async function generateMissing(slug: string) {
  const { missing, sounds } = await soundState(slug);
  const done: string[] = [];
  for (const id of missing) {
    const def = sounds.library.find((s) => s.id === id);
    if (def?.prompt) {
      await generateSound(slug, id);
      done.push(id);
    }
  }
  return done;
}

/** Adds a sound described in words and generates it. */
export async function addCustomSound(slug: string, input: { label: string; prompt: string; seconds?: number; anchor?: 'onset' | 'peak' }) {
  const label = input.label.trim() || input.prompt.trim().slice(0, 40);
  if (!input.prompt.trim()) throw new HttpError(400, 'Describe the sound you want.');
  const sounds = await readSounds(slug);
  let id = slugify(label) || 'sound';
  for (let i = 2; sounds.library.some((s) => s.id === id); i++) id = `${slugify(label)}-${i}`;
  const def: SoundDef = {
    id,
    label,
    prompt: `${input.prompt.trim()}${/no music/i.test(input.prompt) ? '' : ', no music'}`,
    seconds: input.seconds ?? 1,
    source: 'custom',
    anchor: input.anchor ?? 'onset',
  };
  sounds.library.push(def);
  await writeSounds(slug, sounds);
  return generateSound(slug, id);
}

export async function uploadSound(slug: string, filename: string, data: Buffer, label?: string) {
  const ext = path.extname(filename).toLowerCase();
  if (!['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.aif', '.aiff'].includes(ext)) throw new HttpError(400, 'Upload an audio file (mp3, wav, m4a, ogg, flac or aiff).');
  const sounds = await readSounds(slug);
  const base = slugify(label || path.basename(filename, ext)) || 'sound';
  let id = base;
  for (let i = 2; sounds.library.some((s) => s.id === id); i++) id = `${base}-${i}`;
  const file = `assets/audio/sfx/upload-${id}${ext}`;
  await fsp.mkdir(path.join(projectDir(slug), 'assets/audio/sfx'), { recursive: true });
  await fsp.writeFile(path.join(projectDir(slug), file), data);
  const def: SoundDef = { id, label: label || path.basename(filename, ext), file, source: 'upload', anchor: 'onset' };
  sounds.library.push(def);
  await writeSounds(slug, sounds);
  return def;
}

export async function updateSound(slug: string, id: string, patch: Partial<Pick<SoundDef, 'label' | 'prompt' | 'seconds' | 'anchor'>>) {
  const sounds = await readSounds(slug);
  const def = sounds.library.find((s) => s.id === id);
  if (!def) throw new HttpError(404, `No sound "${id}"`);
  for (const k of ['label', 'prompt', 'seconds', 'anchor'] as const) if (patch[k] !== undefined) (def as any)[k] = patch[k];
  await writeSounds(slug, sounds);
  return def;
}

// ---------------------------------------------------------------------------
// Cues

export async function saveSceneSounds(slug: string, sceneId: string, input: { cues?: SoundCue[]; muted?: string[] }) {
  assertId(sceneId);
  const sounds = await readSounds(slug);
  const current = sounds.scenes[sceneId] ?? { cues: [] };
  if (input.cues) {
    current.cues = input.cues
      .filter((c) => Number.isFinite(c.t) && typeof c.sound === 'string')
      .map((c) => ({ ...c, id: c.id || crypto.randomUUID().slice(0, 8), t: Number(Math.max(0, c.t).toFixed(3)) }))
      .sort((a, b) => a.t - b.t);
  }
  if (input.muted) current.muted = [...new Set(input.muted)];
  sounds.scenes[sceneId] = current;
  await writeSounds(slug, sounds);
}

export async function saveSoundSettings(slug: string, input: { whooshOnCuts?: boolean; gain?: number }) {
  const sounds = await readSounds(slug);
  if (typeof input.whooshOnCuts === 'boolean') sounds.whooshOnCuts = input.whooshOnCuts;
  if (typeof input.gain === 'number') sounds.gain = Math.max(0, Math.min(2, input.gain));
  await writeSounds(slug, sounds);
}

// ---------------------------------------------------------------------------
// Export mix: the music bed plus every cue with a recording.

const mixState = (slug: string) => path.join(internalDir(slug), 'mix.json');

/**
 * Returns the audio file the exporter should use. Without active cues that's the music itself;
 * otherwise a mix in assets/audio/soundtrack.wav, rebuilt only when something changed.
 */
export async function ensureMix(slug: string): Promise<{ file: string; offset: number; warnings: string[] } | null> {
  const project = await getProject(slug);
  const state = await soundState(slug);
  const active = state.cues.filter((c) => !c.muted && state.available[c.sound]);
  const total = project.scenes.reduce((s, x) => s + x.duration, 0);
  const warnings = state.missing.length ? [`No recording yet for: ${state.missing.join(', ')}. Those cues are silent.`] : [];
  const vo = await readVoiceover(slug);
  const allLines = resolveLines(vo, voiceTimeline(project));
  const voice = allLines.filter((l) => l.file && !l.stale);
  const unrecorded = allLines.filter((l) => l.text.trim() && (!l.file || l.stale)).length;
  if (unrecorded) warnings.push(`${unrecorded} voice-over line${unrecorded === 1 ? ' is' : 's are'} not recorded (or changed since) and won't be heard.`);
  if (!active.length && !voice.length) return project.audio ? { file: project.audio.file, offset: project.audio.offset || 0, warnings } : null;

  const key = hash(JSON.stringify([project.audio, active, state.sounds.gain, total, state.sounds.library.map((s) => s.file), voice.map((l) => [l.file, l.start]), vo.gain, vo.duck]));
  try {
    const saved = JSON.parse(await fsp.readFile(mixState(slug), 'utf8'));
    if (saved.key === key && (await exists(path.join(projectDir(slug), MIX_FILE)))) return { file: MIX_FILE, offset: 0, warnings };
  } catch {}

  emit({ type: 'score', project: slug, status: 'rendering', message: 'Mixing music and sound effects…' });
  const samples: Record<string, string> = {};
  const anchors: Record<string, 'onset' | 'peak' | 'start'> = {};
  for (const def of state.sounds.library) {
    if (state.available[def.id]) {
      samples[def.id] = `/p/${slug}/${def.file}`;
      anchors[def.id] = def.anchor ?? 'onset';
    }
  }
  const gain = state.sounds.gain ?? 1;
  const events = active.map((c, i) => ({ kind: 'sfx', type: c.sound, t: c.t, d: 0, v: c.gain * gain, pan: c.pan, rate: c.rate, reverb: 0, seed: i + 1 }));
  for (const line of voice) {
    samples[`voice:${line.id}`] = `/p/${slug}/${line.file}`;
    anchors[`voice:${line.id}`] = 'start';
    events.push({ kind: 'sfx', type: `voice:${line.id}`, t: line.start, d: 0, v: vo.gain, pan: 0, rate: 1, reverb: 0, seed: events.length + 1 });
  }
  const out = await synthesize(events, {
    duration: total,
    master: { gain: 1, reverb: 0, fadeOut: project.audio ? 1.2 : 0 },
    bed: project.audio
      ? { url: `/p/${slug}/${project.audio.file}`, offset: project.audio.offset || 0, duck: { ranges: duckRanges(voice), level: vo.duck } }
      : undefined,
    samples,
    anchors,
    samplesOnly: true,
  });
  await fsp.mkdir(path.dirname(path.join(projectDir(slug), MIX_FILE)), { recursive: true });
  await fsp.writeFile(path.join(projectDir(slug), MIX_FILE), out.wav);
  await fsp.mkdir(internalDir(slug), { recursive: true });
  await fsp.writeFile(mixState(slug), JSON.stringify({ key, at: Date.now() }));
  emit({ type: 'score', project: slug, status: 'done', message: `Mixed ${active.length} sound cues${voice.length ? ` and ${voice.length} voice lines` : ''}${project.audio ? ' over the music' : ''}.` });
  return { file: MIX_FILE, offset: 0, warnings: [...warnings, ...out.errors] };
}
