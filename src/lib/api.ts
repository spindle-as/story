import type { MusicPlan, TimedSection } from '../../shared/music';
import type { Score } from '../../shared/score';
import type { ResolvedCue, SoundCue, SoundsFile } from '../../shared/sound';
import type { ResolvedLine, VoiceoverFile } from '../../shared/voice';
import type { Chat, ChatMessage, Project, ProjectConfig, ProjectSummary, RenderJob, RenderSettings, Version } from '../../shared/types';

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body instanceof Blob || body instanceof ArrayBuffer || typeof body === 'string') {
    init.body = body as BodyInit;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data as any)?.error || String(data) || res.statusText);
  return data as T;
}

const base = (slug: string) => `/api/projects/${slug}`;

export interface ScoreStatus {
  score: Score | null;
  error: string | null;
  cuts: { t: number; beat: number; ms: number }[];
  stale: boolean;
  rendering: boolean;
  moods: { id: string; label: string; description: string; bpm: [number, number, number]; key: string; scale: string }[];
}

export interface MusicTake {
  id: string;
  file: string;
  createdAt: number;
  model: string;
  mood?: string;
  duration: number;
  bpm: number;
  sections: { label: string; scenes: string[]; start: number; duration: number }[];
}

export interface MusicStatus {
  plan: MusicPlan;
  saved: boolean;
  sections: TimedSection[];
  takes: MusicTake[];
  currentTake: string | null;
  timingChanged: boolean;
  key: { configured: boolean; source: 'env' | 'file' | null };
  seconds: number;
  generating: boolean;
}

type MixResult = { summary: string; warnings: string[] };

export interface VoiceStatus {
  voiceover: VoiceoverFile;
  lines: ResolvedLine[];
  budgets: Record<string, number>;
  characters: number;
  pending: string[];
  models: { id: string; label: string }[];
  key: { configured: boolean };
}

export interface VoiceOption {
  id: string;
  name: string;
  category?: string;
  description?: string;
  labels: Record<string, string>;
  preview?: string;
}

export interface SoundState {
  sounds: SoundsFile;
  cues: ResolvedCue[];
  available: Record<string, boolean>;
  missing: string[];
  key: { configured: boolean };
}

export const api = {
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  project: (slug: string) => request<Project>('GET', base(slug)),
  createProject: (input: { name: string; codebase: string; url?: string; width: number; height: number; fps: number; brief?: string }) =>
    request<{ slug: string }>('POST', '/api/projects', input),
  updateProject: (slug: string, patch: Partial<ProjectConfig>) => request<Project>('PATCH', base(slug), patch),

  createScene: (slug: string, title: string, after?: string) => request<{ id: string }>('POST', `${base(slug)}/scenes`, { title, after }),
  updateScene: (slug: string, id: string, patch: { title?: string }) => request('PATCH', `${base(slug)}/scenes/${id}`, patch),
  deleteScene: (slug: string, id: string) => request('DELETE', `${base(slug)}/scenes/${id}`),
  duplicateScene: (slug: string, id: string) => request<{ id: string }>('POST', `${base(slug)}/scenes/${id}/duplicate`),
  reorder: (slug: string, ids: string[]) => request('PUT', `${base(slug)}/order`, { ids }),

  versions: (slug: string, id: string) => request<{ versions: Version[]; current: number }>('GET', `${base(slug)}/scenes/${id}/versions`),
  restore: (slug: string, id: string, version: string) => request('POST', `${base(slug)}/scenes/${id}/versions/${version}/restore`),
  undo: (slug: string, id: string) => request<{ ok: boolean }>('POST', `${base(slug)}/scenes/${id}/undo`),

  readFile: (slug: string, name: 'art-direction.md' | 'theme.css') => request<string>('GET', `${base(slug)}/files/${name}`),
  writeFile: (slug: string, name: 'art-direction.md' | 'theme.css', content: string) =>
    request('PUT', `${base(slug)}/files/${name}`, content, { 'content-type': 'text/plain' }),

  chat: (slug: string, scope: string) => request<Chat>('GET', `${base(slug)}/chats/${scope}`),
  send: (slug: string, scope: string, body: { text: string; playhead?: number; attachments?: string[] }) =>
    request<ChatMessage>('POST', `${base(slug)}/chats/${scope}`, body),
  stop: (slug: string, scope: string) => request('POST', `${base(slug)}/chats/${scope}/stop`),
  clearChat: (slug: string, scope: string) => request('DELETE', `${base(slug)}/chats/${scope}`),

  upload: (slug: string, file: File) =>
    request<{ path: string; url: string }>('POST', `${base(slug)}/uploads`, file, { 'x-filename': file.name || 'pasted.png' }),
  uploadAudio: (slug: string, file: File) =>
    request<{ file: string; url: string }>('POST', `${base(slug)}/audio`, file, { 'x-filename': file.name }),

  renders: (slug: string) => request<RenderJob[]>('GET', `${base(slug)}/renders`),
  render: (slug: string, settings: RenderSettings) => request<RenderJob>('POST', `${base(slug)}/renders`, settings),
  cancelRender: (id: string) => request('POST', `/api/renders/${id}/cancel`),

  scoreStatus: (slug: string) => request<ScoreStatus>('GET', `${base(slug)}/score`),
  composeScore: (slug: string, input: { mood: string; bpm?: number; key?: string; sfx?: boolean }) =>
    request<{ summary: string; warnings: string[] }>('POST', `${base(slug)}/score/compose`, input),
  renderScore: (slug: string) => request<{ summary: string; warnings: string[] }>('POST', `${base(slug)}/score/render`),
  snapToBeat: (slug: string) => request<{ changes: { scene: string; from: number; to: number }[] }>('POST', `${base(slug)}/score/snap`),

  setElevenLabsKey: (apiKey: string | null) => request('PUT', '/api/settings/elevenlabs', { apiKey }),
  music: (slug: string) => request<MusicStatus>('GET', `${base(slug)}/music`),
  saveMusic: (slug: string, plan: MusicPlan) => request<MusicStatus>('PUT', `${base(slug)}/music`, plan),
  proposeMusic: (slug: string, mood: string) => request<MusicPlan>('POST', `${base(slug)}/music/propose`, { mood }),
  generateMusic: (slug: string) => request<MixResult>('POST', `${base(slug)}/music/generate`),
  useTake: (slug: string, takeId?: string) => request<MixResult>('POST', `${base(slug)}/music/use`, { takeId }),

  sounds: (slug: string) => request<SoundState>('GET', `${base(slug)}/sounds`),
  saveSceneSounds: (slug: string, scene: string, body: { cues?: SoundCue[]; muted?: string[] }) =>
    request<SoundState>('PUT', `${base(slug)}/sounds/scenes/${scene}`, body),
  soundSettings: (slug: string, body: { whooshOnCuts?: boolean; gain?: number }) => request<SoundState>('PATCH', `${base(slug)}/sounds`, body),
  addSound: (slug: string, body: { label: string; prompt: string; seconds?: number; anchor?: 'onset' | 'peak' }) =>
    request<SoundState>('POST', `${base(slug)}/sounds/library`, body),
  uploadSound: (slug: string, file: File, label?: string) =>
    request<SoundState>('POST', `${base(slug)}/sounds/library/upload`, file, {
      'x-filename': file.name,
      ...(label ? { 'x-label': encodeURIComponent(label) } : {}),
    }),
  updateSound: (slug: string, id: string, body: { label?: string; prompt?: string; seconds?: number; anchor?: 'onset' | 'peak' }) =>
    request<SoundState>('PATCH', `${base(slug)}/sounds/library/${id}`, body),
  generateSound: (slug: string, id: string) => request<SoundState>('POST', `${base(slug)}/sounds/library/${id}/generate`),
  generateMissingSounds: (slug: string) => request<SoundState>('POST', `${base(slug)}/sounds/generate-missing`),

  voices: (search?: string) => request<VoiceOption[]>('GET', `/api/voices${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  voice: (slug: string) => request<VoiceStatus>('GET', `${base(slug)}/voice`),
  saveVoice: (slug: string, body: Partial<VoiceoverFile>) => request<VoiceStatus>('PUT', `${base(slug)}/voice`, body),
  recordLine: (slug: string, id: string) => request<VoiceStatus>('POST', `${base(slug)}/voice/lines/${id}/generate`),
  recordPending: (slug: string) => request<VoiceStatus>('POST', `${base(slug)}/voice/generate`),

  reveal: (path: string) => request('POST', '/api/reveal', { path }),
  pickFolder: () => request<{ path: string | null }>('POST', '/api/pick-folder'),
  checkFolder: (path: string) =>
    request<{ ok: boolean; name?: string; markers?: string[] }>('GET', `/api/fs/check?path=${encodeURIComponent(path)}`),
};
