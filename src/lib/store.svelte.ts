import type { Chat, ChatMessage, Project, ProjectSummary, RenderJob, SceneInfo } from '../../shared/types';
import { duckRanges } from '../../shared/voice';
import { api, type SoundState, type VoiceStatus } from './api';
import { AudioEngine } from './audio';

export type Modal = null | 'new-project' | 'art-direction' | 'versions' | 'settings' | 'soundtrack';

class Store {
  projects = $state<ProjectSummary[]>([]);
  project = $state<Project | null>(null);
  sceneId = $state<string | null>(null);
  view = $state<'scenes' | 'render'>('scenes');
  panel = $state<'scene' | 'project' | 'sound' | 'voice'>('scene');
  chats = $state<Record<string, Chat>>({});
  renders = $state<RenderJob[]>([]);
  /** Per-scene reload key; bumped when a scene file changes on disk. */
  reloadKeys = $state<Record<string, number>>({});
  assetsKey = $state(0);

  mode = $state<'scene' | 'whole'>('scene');
  playing = $state(false);
  /** Scene-local seconds in "scene" mode, video seconds in "whole" mode. */
  time = $state(0);
  muted = $state(false);

  modal = $state<Modal>(null);
  presenting = $state(false);
  toast = $state<{ text: string; kind: 'info' | 'error' } | null>(null);
  loaded = $state(false);
  /** Soundtrack rendering status, pushed by the server. */
  score = $state<{ status: 'idle' | 'rendering' | 'done' | 'error'; message?: string }>({ status: 'idle' });

  /** Music bed and sound cues, played live in sync with the playhead. */
  engine = new AudioEngine();
  sounds = $state<SoundState | null>(null);
  voice = $state<VoiceStatus | null>(null);
  #soundsTimer: ReturnType<typeof setTimeout> | undefined;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;

  scenes = $derived<SceneInfo[]>(this.project?.scenes ?? []);
  scene = $derived<SceneInfo | null>(this.scenes.find((s) => s.id === this.sceneId) ?? this.scenes[0] ?? null);
  sceneIndex = $derived(this.scene ? this.scenes.indexOf(this.scene) : -1);
  starts = $derived.by(() => {
    let acc = 0;
    return this.scenes.map((s) => {
      const start = acc;
      acc += s.duration;
      return start;
    });
  });
  total = $derived(this.scenes.reduce((sum, s) => sum + s.duration, 0));
  duration = $derived(this.mode === 'whole' ? this.total : (this.scene?.duration ?? 0));

  /** Index of the scene on screen right now. */
  activeIndex = $derived.by(() => {
    if (this.mode === 'scene') return this.sceneIndex;
    const i = this.starts.findLastIndex((start) => this.time >= start - 1e-9);
    return Math.max(0, Math.min(i, this.scenes.length - 1));
  });
  /** Time inside the scene on screen. */
  localTime = $derived(this.mode === 'scene' ? this.time : this.time - (this.starts[this.activeIndex] ?? 0));

  notify(text: string, kind: 'info' | 'error' = 'info') {
    this.toast = { text, kind };
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => (this.toast = null), kind === 'error' ? 6000 : 2500);
  }

  async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      this.notify((e as Error).message, 'error');
    }
  }

  async init() {
    this.connect();
    this.projects = await api.projects();
    const [hashProject, hashScene] = location.hash.slice(2).split('/');
    const slug = this.projects.find((p) => p.slug === hashProject)?.slug ?? localStorage.getItem('story:project') ?? this.projects[0]?.slug;
    if (slug && this.projects.some((p) => p.slug === slug)) await this.openProject(slug, hashScene);
    else if (!this.projects.length) this.modal = 'new-project';
    this.loaded = true;
  }

  async openProject(slug: string, sceneId?: string) {
    this.pause();
    this.project = await api.project(slug);
    this.chats = {};
    this.renders = [];
    this.time = 0;
    this.mode = 'scene';
    this.sceneId = this.project.scenes.find((s) => s.id === sceneId)?.id ?? this.project.scenes[0]?.id ?? null;
    this.time = this.scene?.poster ?? 0;
    try {
      localStorage.setItem('story:project', slug);
    } catch {}
    this.syncHash();
    this.sounds = null;
    this.voice = null;
    this.setupAudio();
    this.loadSounds();
    api.renders(slug).then((r) => (this.renders = r));
  }

  async refreshProject() {
    if (!this.project) return;
    const slug = this.project.slug;
    const next = await api.project(slug);
    if (this.project?.slug !== slug) return;
    const audioChanged = JSON.stringify(next.audio) !== JSON.stringify(this.project.audio);
    this.project = next;
    if (!next.scenes.some((s) => s.id === this.sceneId)) this.sceneId = next.scenes[0]?.id ?? null;
    if (audioChanged) this.setupAudio();
    this.scheduleSounds();
    this.clampTime();
  }

  scheduleRefresh() {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => this.refreshProject(), 80);
  }

  async refreshProjects() {
    this.projects = await api.projects();
  }

  syncHash() {
    if (!this.project) return;
    const hash = `#/${this.project.slug}${this.sceneId ? `/${this.sceneId}` : ''}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  selectScene(id: string, opts: { keepTime?: boolean } = {}) {
    const index = this.scenes.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.sceneId = id;
    if (this.mode === 'whole') this.seek(this.starts[index]);
    else if (!opts.keepTime) this.seek(this.playing ? 0 : this.scenes[index].poster);
    this.syncHash();
  }

  setMode(mode: 'scene' | 'whole') {
    if (mode === this.mode) return;
    const index = this.activeIndex;
    const local = this.localTime;
    this.mode = mode;
    if (mode === 'whole') this.time = (this.starts[index] ?? 0) + local;
    else this.time = local;
    this.syncAudio();
  }

  clampTime() {
    this.time = Math.min(Math.max(0, this.time), Math.max(0, this.duration - 0.0001));
  }

  seek(t: number) {
    this.time = t;
    this.clampTime();
    if (this.mode === 'whole' && this.scenes[this.activeIndex] && this.sceneId !== this.scenes[this.activeIndex].id) {
      this.sceneId = this.scenes[this.activeIndex].id;
      this.syncHash();
    }
    this.syncAudio();
  }

  step(frames: number) {
    const fps = this.project?.fps ?? 60;
    this.pause();
    this.seek(Math.round(this.time * fps + frames) / fps);
  }

  // ---------------------------------------------------------------------------
  // Playback clock. Driven by rAF, or by the audio element when music is playing.

  #raf = 0;
  #last = 0;

  play() {
    if (!this.scene) return;
    if (this.time >= this.duration - 0.001) this.time = 0;
    this.playing = true;
    this.#last = performance.now();
    this.syncAudio();
    cancelAnimationFrame(this.#raf);
    this.#raf = requestAnimationFrame(this.#tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.#raf);
    this.engine.stop();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Video seconds the playhead is at. */
  videoTime() {
    return this.mode === 'scene' ? (this.starts[this.sceneIndex] ?? 0) + this.time : this.time;
  }

  #tick = (now: number) => {
    if (!this.playing) return;
    const dt = Math.min(0.1, (now - this.#last) / 1000);
    this.#last = now;
    const base = this.mode === 'scene' ? (this.starts[this.sceneIndex] ?? 0) : 0;
    let t = this.engine.running ? this.engine.now() - base : this.time + dt;
    if (t >= this.duration) {
      if (this.mode === 'scene' || this.presenting) {
        t = 0;
        this.time = 0;
        this.syncAudio();
      } else {
        this.time = Math.max(0, this.duration - 0.0001);
        this.pause();
        return;
      }
    }
    this.time = t;
    if (this.mode === 'whole') {
      const active = this.scenes[this.activeIndex];
      if (active && active.id !== this.sceneId) {
        this.sceneId = active.id;
        this.syncHash();
      }
    }
    this.#raf = requestAnimationFrame(this.#tick);
  };

  setupAudio() {
    const track = this.project?.audio;
    // Generated scores keep their file name, so the version busts the browser cache.
    const url = track && this.project ? `/p/${this.project.slug}/${track.file}${track.version ? `?v=${track.version}` : ''}` : null;
    this.engine.setBed(url, track?.offset ?? 0).then(() => this.playing && this.syncAudio());
  }

  /** (Re)starts the engine at the playhead, or stops it when paused or muted. */
  syncAudio() {
    if (!this.playing || this.muted) {
      this.engine.stop();
      return;
    }
    const start = this.videoTime();
    const until = this.mode === 'scene' ? (this.starts[this.sceneIndex] ?? 0) + this.duration : Infinity;
    this.engine.start(start, until);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.syncAudio();
  }

  /** Loads the sound library and every cue, and hands the recordings to the engine. */
  async loadSounds() {
    if (!this.project) return;
    const slug = this.project.slug;
    const state = await api.sounds(slug).catch(() => null);
    if (!state || this.project?.slug !== slug) return;
    this.sounds = state;
    const urls: Record<string, string> = {};
    const anchors: Record<string, 'onset' | 'peak'> = {};
    for (const def of state.sounds.library) {
      if (state.available[def.id] && def.file) urls[def.id] = `/p/${slug}/${def.file}`;
      anchors[def.id] = def.anchor ?? 'onset';
    }
    this.engine.setCues(state.cues, state.sounds.gain ?? 1);
    await this.engine.setSamples(urls, anchors);
    await this.loadVoice();
    if (this.playing) this.syncAudio();
  }

  /** Voice-over lines for the editor, recorded ones handed to the engine. */
  async loadVoice() {
    if (!this.project) return;
    const slug = this.project.slug;
    const status = await api.voice(slug).catch(() => null);
    if (!status || this.project?.slug !== slug) return;
    this.voice = status;
    const recorded = status.lines.filter((l) => l.file && !l.stale);
    await this.engine.setVoice(
      recorded.map((l) => ({ id: l.id, url: `/p/${slug}/${l.file}`, start: l.start })),
      status.voiceover.gain,
      { ranges: duckRanges(recorded), level: status.voiceover.duck },
    );
  }

  scheduleSounds() {
    clearTimeout(this.#soundsTimer);
    this.#soundsTimer = setTimeout(() => this.loadSounds(), 300);
  }

  // ---------------------------------------------------------------------------
  // Chats

  async loadChat(scope: string) {
    if (!this.project) return;
    const slug = this.project.slug;
    const chat = await api.chat(slug, scope);
    if (this.project?.slug === slug) this.chats[scope] = chat;
  }

  upsertMessage(scope: string, message: ChatMessage) {
    const chat = (this.chats[scope] ??= { scope, messages: [] });
    const i = chat.messages.findIndex((m) => m.id === message.id);
    if (i >= 0) chat.messages[i] = message;
    else chat.messages.push(message);
  }

  // ---------------------------------------------------------------------------
  // Server events

  connect() {
    const source = new EventSource('/api/events');
    source.onmessage = (e) => {
      const evt = JSON.parse(e.data);
      if (evt.project !== this.project?.slug) {
        if (evt.type === 'project') this.refreshProjects();
        return;
      }
      switch (evt.type) {
        case 'project':
          this.scheduleRefresh();
          break;
        case 'scene':
          this.reloadKeys[evt.scene] = evt.version;
          this.scheduleSounds();
          break;
        case 'sounds':
          this.scheduleSounds();
          break;
        case 'assets':
          this.assetsKey = evt.version;
          break;
        case 'chat':
          this.upsertMessage(evt.scope, evt.message);
          break;
        case 'chat-delta': {
          const message = this.chats[evt.scope]?.messages.find((m) => m.id === evt.id);
          if (message) message.text = evt.text;
          break;
        }
        case 'score':
          this.score = { status: evt.status, message: evt.message };
          if (evt.status === 'error') this.notify(`Soundtrack: ${evt.message}`, 'error');
          break;
        case 'render': {
          const i = this.renders.findIndex((r) => r.id === evt.job.id);
          if (i >= 0) this.renders[i] = evt.job;
          else this.renders.unshift(evt.job);
          if (evt.job.status === 'done' && i >= 0) this.notify('Render finished');
          break;
        }
      }
    };
  }
}

export const store = new Store();

export const fmtTime = (t: number, digits = 2) => (Math.max(0, t) || 0).toFixed(digits);
