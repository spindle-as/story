import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  emptyVoiceover,
  lineHash,
  resolveLines,
  VOICE_MODELS,
  wordBudget,
  wordsFromAlignment,
  type VoiceLine,
  type VoiceoverFile,
} from '../shared/voice.ts';
import type { Project } from '../shared/types.ts';
import { emit } from './events.ts';
import { assertId, HttpError, projectDir } from './paths.ts';
import { getProject } from './projects.ts';
import { elevenLabsKey } from './settings.ts';

const API = process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io/v1';
const API_V2 = API.replace(/\/v1$/, '/v2');
const voFile = (slug: string) => path.join(projectDir(slug), 'voiceover.json');

export async function readVoiceover(slug: string): Promise<VoiceoverFile> {
  try {
    return { ...emptyVoiceover(), ...JSON.parse(await fsp.readFile(voFile(slug), 'utf8')) };
  } catch {
    return emptyVoiceover();
  }
}

async function writeVoiceover(slug: string, vo: VoiceoverFile) {
  await fsp.writeFile(voFile(slug), JSON.stringify(vo, null, 2) + '\n');
  emit({ type: 'sounds', project: slug });
}

export function timeline(project: Project) {
  let start = 0;
  return project.scenes.map((s) => {
    const entry = { id: s.id, start, duration: s.duration };
    start += s.duration;
    return entry;
  });
}

async function requireKey() {
  const { key } = await elevenLabsKey();
  if (!key) throw new HttpError(400, 'Add your ElevenLabs API key in the Soundtrack dialog first.');
  return key;
}

async function apiError(res: Response) {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body: any = await res.json();
    const d = body?.detail ?? body;
    detail = typeof d === 'string' ? d : d?.message ?? JSON.stringify(d);
  } catch {}
  return new HttpError(res.status === 401 ? 401 : 502, `ElevenLabs: ${detail}`);
}

// ---------------------------------------------------------------------------

let voiceCache: { at: number; voices: unknown[] } | null = null;

/** The voices available to the account (premade plus the user's own), cached for 10 minutes. */
export async function listVoices(search?: string) {
  const key = await requireKey();
  if (!search && voiceCache && Date.now() - voiceCache.at < 600_000) return voiceCache.voices;
  const voices: unknown[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${API_V2}/voices`);
    url.searchParams.set('page_size', '100');
    if (search) url.searchParams.set('search', search);
    if (token) url.searchParams.set('next_page_token', token);
    const res = await fetch(url, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw await apiError(res);
    const body: any = await res.json();
    for (const v of body.voices ?? []) {
      voices.push({ id: v.voice_id, name: v.name, category: v.category, description: v.description, labels: v.labels ?? {}, preview: v.preview_url });
    }
    if (!body.has_more || !body.next_page_token) break;
    token = body.next_page_token;
  }
  if (!search) voiceCache = { at: Date.now(), voices };
  return voices;
}

export async function voiceStatus(slug: string) {
  const project = await getProject(slug);
  const vo = await readVoiceover(slug);
  const scenes = timeline(project);
  const lines = resolveLines(vo, scenes);
  const { source } = await elevenLabsKey();
  return {
    voiceover: vo,
    lines,
    budgets: Object.fromEntries(scenes.map((s) => [s.id, wordBudget(s.duration)])),
    characters: vo.lines.reduce((n, l) => n + l.text.trim().length, 0),
    pending: lines.filter((l) => l.text.trim() && (!l.file || l.stale)).map((l) => l.id),
    models: VOICE_MODELS,
    key: { configured: !!source },
  };
}

export async function saveVoiceover(slug: string, input: Partial<VoiceoverFile>) {
  const vo = await readVoiceover(slug);
  for (const k of ['voice', 'model', 'settings', 'direction', 'gain', 'duck', 'captions'] as const) {
    if (k in input) (vo as any)[k] = input[k];
  }
  if (Array.isArray(input.lines)) {
    const before = new Map(vo.lines.map((l) => [l.id, l]));
    vo.lines = input.lines
      .filter((l) => typeof l.text === 'string' && typeof l.scene === 'string')
      .map((l) => {
        const id = l.id && /^[\w-]+$/.test(l.id) ? l.id : crypto.randomUUID().slice(0, 8);
        // Keep generated audio when only the text box was re-sent unchanged.
        const prev = before.get(id);
        return { ...prev, ...l, id, scene: assertId(l.scene), t: Number(Math.max(0, Number(l.t) || 0).toFixed(3)) };
      });
  }
  await writeVoiceover(slug, vo);
}

/** Speaks one line with ElevenLabs (costs credits) and stores the audio with per-word timings. */
export async function generateLine(slug: string, lineId: string) {
  const key = await requireKey();
  const vo = await readVoiceover(slug);
  if (!vo.voice) throw new HttpError(400, 'Pick a voice first.');
  const project = await getProject(slug);
  const ordered = resolveLines(vo, timeline(project));
  const index = ordered.findIndex((l) => l.id === lineId);
  const line = vo.lines.find((l) => l.id === lineId);
  if (!line || index < 0) throw new HttpError(404, 'No such voice-over line.');
  if (!line.text.trim()) throw new HttpError(400, 'The line is empty.');

  const model = VOICE_MODELS.find((m) => m.id === vo.model);
  const body: Record<string, unknown> = {
    text: line.text.trim(),
    model_id: vo.model,
    voice_settings: {
      stability: vo.settings.stability,
      similarity_boost: vo.settings.similarity,
      style: vo.settings.style,
      use_speaker_boost: true,
      speed: vo.settings.speed,
    },
  };
  // Neighbouring lines keep intonation continuous across the whole read.
  if (model?.stitching !== false) {
    if (ordered[index - 1]) body.previous_text = ordered[index - 1].text;
    if (ordered[index + 1]) body.next_text = ordered[index + 1].text;
  }
  emit({ type: 'score', project: slug, status: 'rendering', message: `Recording “${line.text.slice(0, 40)}${line.text.length > 40 ? '…' : ''}”` });
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(vo.voice.id)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const err = await apiError(res);
    emit({ type: 'score', project: slug, status: 'error', message: err.message });
    throw err;
  }
  const out: any = await res.json();
  const words = out.alignment ? wordsFromAlignment(out.alignment) : [];
  const hash = lineHash(line, vo);
  const file = `assets/audio/voice/${line.id}-${hash}.mp3`;
  await fsp.mkdir(path.join(projectDir(slug), 'assets/audio/voice'), { recursive: true });
  await fsp.writeFile(path.join(projectDir(slug), file), Buffer.from(out.audio_base64, 'base64'));

  // Re-read: the user may have edited other lines while this one was recording.
  const latest = await readVoiceover(slug);
  const target = latest.lines.find((l) => l.id === lineId);
  if (target) {
    if (target.file && target.file !== file) await fsp.rm(path.join(projectDir(slug), target.file), { force: true });
    Object.assign(target, { file, hash, words, duration: words.length ? Number(words.at(-1)!.e.toFixed(3)) : undefined });
    await writeVoiceover(slug, latest);
  }
  emit({ type: 'score', project: slug, status: 'done', message: 'Voice line recorded' });
  return target;
}

/** Records every line that's new or changed since it was last recorded. */
export async function generatePending(slug: string) {
  const { pending } = await voiceStatus(slug);
  for (const id of pending) await generateLine(slug, id);
  return pending.length;
}

export function lineText(line: VoiceLine) {
  return line.text.replace(/\s+/g, ' ').trim();
}
