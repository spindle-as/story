import fsp from 'node:fs/promises';
import path from 'node:path';
import { defaultPlan, elevenLabsRequest, timeSections, type MusicPlan } from '../shared/music.ts';
import { MOODS, type Mood } from '../shared/score.ts';
import { emit } from './events.ts';
import { HttpError, internalDir, projectDir } from './paths.ts';
import { getProject, readConfig, writeConfig } from './projects.ts';
import { analyzeAudio } from './renderer.ts';
import { elevenLabsKey } from './settings.ts';

// Overridable for tests against a local mock.
const API = process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io/v1';
const planFile = (slug: string) => path.join(projectDir(slug), 'music.json');
const takesFile = (slug: string) => path.join(internalDir(slug), 'music-takes.json');

/** Bump when runtime/beats.js changes, so stored takes get their beats re-detected. */
const ANALYSIS_VERSION = 2;

export interface Take {
  analysisVersion?: number;
  id: string;
  file: string;
  createdAt: number;
  model: string;
  mood?: string;
  sections: { label: string; scenes: string[]; start: number; duration: number }[];
  requestedSeconds: number;
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
}

export async function readPlan(slug: string): Promise<{ plan: MusicPlan; saved: boolean }> {
  try {
    return { plan: JSON.parse(await fsp.readFile(planFile(slug), 'utf8')), saved: true };
  } catch {
    const project = await getProject(slug);
    return { plan: defaultPlan(project.scenes, 'minimal'), saved: false };
  }
}

export async function savePlan(slug: string, plan: MusicPlan) {
  if (!Array.isArray(plan?.styles) || !Array.isArray(plan?.sections) || !plan.sections.length) {
    throw new HttpError(400, 'A music plan needs "styles" and at least one section.');
  }
  await fsp.writeFile(planFile(slug), JSON.stringify(plan, null, 2) + '\n');
}

export async function proposePlan(slug: string, mood: Mood) {
  const project = await getProject(slug);
  return defaultPlan(project.scenes, mood in MOODS ? mood : 'minimal');
}

async function readTakes(slug: string): Promise<Take[]> {
  try {
    return JSON.parse(await fsp.readFile(takesFile(slug), 'utf8'));
  } catch {
    return [];
  }
}

async function writeTakes(slug: string, takes: Take[]) {
  await fsp.mkdir(internalDir(slug), { recursive: true });
  await fsp.writeFile(takesFile(slug), JSON.stringify(takes, null, 2));
}

async function apiError(res: Response) {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body: any = await res.json();
    const d = body?.detail ?? body;
    detail = typeof d === 'string' ? d : d?.message ?? (Array.isArray(d) ? d.map((x: any) => x.msg ?? JSON.stringify(x)).join('; ') : JSON.stringify(d));
  } catch {}
  if (res.status === 401) detail = `ElevenLabs rejected the API key (${detail}).`;
  return new HttpError(res.status === 401 ? 401 : 502, `ElevenLabs: ${detail}`);
}

/** Makes a take the project's music. Sound effects are mixed over it separately (see sound.ts). */
async function useAsMusic(slug: string, take: Take) {
  const takes = await readTakes(slug);
  const config = await readConfig(slug);
  config.audio = {
    file: take.file,
    name: `ElevenLabs take ${takes.findIndex((t) => t.id === take.id) + 1}${take.mood ? ` (${take.mood})` : ''}`,
    duration: take.duration,
    offset: 0,
    bpm: take.bpm,
    beats: take.beats,
    downbeats: take.downbeats,
    generated: true,
    provider: 'elevenlabs',
    takeId: take.id,
    version: Date.now(),
    mood: take.mood,
  };
  await writeConfig(slug, config);
  emit({ type: 'project', project: slug });
  const summary = `Using take ${takes.findIndex((t) => t.id === take.id) + 1}: ${take.duration.toFixed(2)}s, ~${Math.round(take.bpm)} BPM. Sections: ${take.sections
    .map((s) => `${s.label} ${s.start.toFixed(2)}–${(s.start + s.duration).toFixed(2)}s`)
    .join(', ')}.`;
  emit({ type: 'score', project: slug, status: 'done', message: summary });
  return { summary, warnings: [] as string[] };
}

const running = new Map<string, Promise<unknown>>();

function exclusive<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(slug)) throw new HttpError(409, 'Music is already being generated.');
  const job = fn()
    .catch((e) => {
      emit({ type: 'score', project: slug, status: 'error', message: (e as Error).message });
      throw e;
    })
    .finally(() => running.delete(slug));
  running.set(slug, job);
  return job;
}

/** Generates a new take from music.json (costs ElevenLabs credits) and uses it. */
export function generateMusic(slug: string) {
  return exclusive(slug, async () => {
    const { key } = await elevenLabsKey();
    if (!key) throw new HttpError(400, 'Add your ElevenLabs API key in the Soundtrack dialog first.');
    const { plan, saved } = await readPlan(slug);
    if (!saved) await savePlan(slug, plan);
    const project = await getProject(slug);
    if (!project.scenes.length) throw new HttpError(400, 'Add scenes before generating music.');
    const request = elevenLabsRequest(plan, project.scenes);
    if (request.totalSeconds < 3) throw new HttpError(400, 'The video must be at least 3 seconds long for ElevenLabs Music.');

    emit({ type: 'score', project: slug, status: 'rendering', message: `Composing ${request.totalSeconds.toFixed(1)}s of music with ElevenLabs (this takes a minute)…` });
    const res = await fetch(`${API}/music?output_format=mp3_48000_192`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok) throw await apiError(res);

    const id = Date.now().toString(36);
    const file = `assets/audio/takes/${id}.mp3`;
    await fsp.mkdir(path.join(projectDir(slug), 'assets/audio/takes'), { recursive: true });
    await fsp.writeFile(path.join(projectDir(slug), file), Buffer.from(await res.arrayBuffer()));

    emit({ type: 'score', project: slug, status: 'rendering', message: 'Finding the beat…' });
    const analysis = await analyzeAudio(`/p/${slug}/${file}`);
    const take: Take = {
      id,
      file,
      createdAt: Date.now(),
      model: plan.model,
      mood: plan.mood,
      sections: request.sections.map(({ label, scenes, start, duration }) => ({ label, scenes, start, duration })),
      requestedSeconds: request.totalSeconds,
      ...analysis,
      analysisVersion: ANALYSIS_VERSION,
    };
    await writeTakes(slug, [...(await readTakes(slug)), take]);
    const result = await useAsMusic(slug, take);
    if (Math.abs(analysis.duration - request.totalSeconds) > 0.5) {
      result.warnings.push(`ElevenLabs returned ${analysis.duration.toFixed(1)}s for a ${request.totalSeconds.toFixed(1)}s request; the end is trimmed or padded to the video.`);
    }
    return { ...result, take };
  });
}

/** Switches to a take (re-detecting its beats if the detector improved since). */
export function useTake(slug: string, takeId?: string) {
  return exclusive(slug, async () => {
    const takes = await readTakes(slug);
    const project = await getProject(slug);
    const id = takeId ?? project.audio?.takeId ?? takes.at(-1)?.id;
    let take = takes.find((t) => t.id === id);
    if (!take) throw new HttpError(404, 'No generated take to use yet. Generate one first.');
    if (take.analysisVersion !== ANALYSIS_VERSION) {
      emit({ type: 'score', project: slug, status: 'rendering', message: 'Finding the beat…' });
      take = { ...take, ...(await analyzeAudio(`/p/${slug}/${take.file}`)), analysisVersion: ANALYSIS_VERSION };
      await writeTakes(slug, takes.map((t) => (t.id === take!.id ? take! : t)));
    }
    return useAsMusic(slug, take);
  });
}

export async function musicStatus(slug: string) {
  const project = await getProject(slug);
  const { plan, saved } = await readPlan(slug);
  const takes = await readTakes(slug);
  const sections = timeSections(plan, project.scenes);
  const current = project.audio?.provider === 'elevenlabs' ? takes.find((t) => t.id === project.audio!.takeId) : undefined;
  // Snapping moves cuts by less than a beat on purpose; only warn when a section moved further.
  const beat = current?.bpm ? 60 / current.bpm : 0.5;
  const timingChanged =
    !!current &&
    (current.sections.length !== sections.length || current.sections.some((s, i) => Math.abs(s.start - sections[i].start) > beat + 0.02));
  const { source } = await elevenLabsKey();
  return {
    plan,
    saved,
    sections,
    takes: takes.slice().reverse(),
    currentTake: current?.id ?? null,
    timingChanged,
    key: { configured: !!source, source },
    seconds: sections.reduce((s, x) => s + x.duration, 0),
    generating: running.has(slug),
  };
}
