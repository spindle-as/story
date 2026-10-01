export interface AudioTrack {
  /** Path relative to the project directory. */
  file: string;
  name: string;
  duration: number;
  /** Seconds into the audio file where the video starts. */
  offset: number;
  bpm?: number;
  beats: number[];
  downbeats: number[];
  /** Set when the track was rendered from score.json rather than uploaded. */
  generated?: boolean;
  /** Hash of score.json and the scenes it was rendered from; a mismatch means it is stale. */
  sourceHash?: string;
  /** Bumped on every render so players reload the file. */
  version?: number;
  key?: string;
  mood?: string;
  /** Where a generated track came from: the built-in synth (score.json) or ElevenLabs (music.json). */
  provider?: 'synth' | 'elevenlabs';
  /** The ElevenLabs take this mix uses. */
  takeId?: string;
}

export interface SceneEntry {
  id: string;
  title: string;
}

export interface ProjectConfig {
  name: string;
  /** Absolute path to the codebase the video is about. Read-only for the agent. */
  codebase: string;
  /** Optional URL of a running instance, used by `story capture`. */
  url?: string;
  width: number;
  height: number;
  fps: number;
  model?: string;
  audio?: AudioTrack | null;
  scenes: SceneEntry[];
  createdAt: string;
}

export interface SceneInfo extends SceneEntry {
  duration: number;
  poster: number;
  tags: string[];
  file: string;
  url: string;
  /** Changes whenever the file content changes; used to bust iframe caches. */
  version: number;
  versions: number;
  busy: boolean;
}

export interface Project extends Omit<ProjectConfig, 'scenes'> {
  slug: string;
  dir: string;
  scenes: SceneInfo[];
  projectBusy: boolean;
  assetsVersion: number;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  codebase: string;
  scenes: number;
  duration: number;
  updatedAt: number;
}

export interface Activity {
  kind: 'tool' | 'note';
  label: string;
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  attachments?: string[];
  playhead?: number;
  status?: 'running' | 'done' | 'error' | 'stopped';
  activity?: Activity[];
  durationMs?: number;
  costUsd?: number;
}

export interface Chat {
  scope: string;
  sessionId?: string;
  messages: ChatMessage[];
}

export interface Version {
  id: string;
  ts: number;
  hash: string;
  label: string;
  duration: number;
}

export interface RenderSettings {
  fps: number;
  scale: number;
  scope: 'all' | string;
  audio: boolean;
}

export interface RenderJob {
  id: string;
  project: string;
  status: 'rendering' | 'encoding' | 'done' | 'error' | 'cancelled';
  frames: number;
  totalFrames: number;
  startedAt: number;
  finishedAt?: number;
  file?: string;
  url?: string;
  /** Captions (.srt) from the voice-over, when there is one. */
  captionsUrl?: string;
  size?: number;
  error?: string;
  settings: RenderSettings;
  width: number;
  height: number;
  duration: number;
}
