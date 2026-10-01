/**
 * Sound design: a library of sounds and the cues that play them.
 *
 * projects/<slug>/sounds.json holds the library (presets, sounds described in words, uploads)
 * and per-scene cues in scene time. Scenes also produce automatic cues: cursor clicks, typing
 * (one keystroke per character) and Story.sound() calls. resolveCues() merges everything into
 * one list in video time, used both by the editor's live preview and by the export mix.
 */

export interface SoundDef {
  id: string;
  label: string;
  /** Description used to generate it with ElevenLabs Sound Effects. */
  prompt?: string;
  seconds?: number;
  /** Project-relative audio file once generated or uploaded. */
  file?: string;
  source: 'preset' | 'custom' | 'upload';
  /** Align the sound's start (onset) or its loudest moment (peak) with the cue time. */
  anchor?: 'onset' | 'peak';
  /** How many times it has been generated; each variant is a new file. */
  variant?: number;
}

export interface SoundCue {
  id: string;
  /** Seconds from the start of the scene. */
  t: number;
  sound: string;
  gain?: number;
  pan?: number;
  note?: string;
}

export interface SceneSounds {
  cues: SoundCue[];
  /** Ids of automatic cues the user turned off. */
  muted?: string[];
}

export interface SoundsFile {
  version: 1;
  library: SoundDef[];
  scenes: Record<string, SceneSounds>;
  /** A whoosh on every cut between scenes. Off by default; it rarely suits every cut. */
  whooshOnCuts?: boolean;
  /** Overall sound effects level, 0–2. */
  gain?: number;
}

/** What a scene reports from Story.cues(): helper cues (click, typing) and Story.sound() calls. */
export interface SceneCueReport {
  type: string;
  t: number;
  d?: number;
  chars?: number;
  gain?: number;
  pan?: number;
  source: 'scene' | 'helper';
}

export interface ResolvedCue {
  /** Stable id: manual cue id, or "auto:<scene>:<kind>:<ms>". */
  id: string;
  scene: string;
  /** Video seconds. */
  t: number;
  /** Scene seconds. */
  local: number;
  sound: string;
  gain: number;
  pan: number;
  /** Playback rate, used to vary repeated keystrokes. */
  rate: number;
  auto: boolean;
  muted: boolean;
  label: string;
}

export const PRESETS: SoundDef[] = [
  { id: 'click', label: 'Mouse click', prompt: 'Single crisp soft mouse click, clean modern UI, very short and dry, no music', seconds: 0.5, source: 'preset', anchor: 'onset' },
  { id: 'tick', label: 'Checkbox tick', prompt: 'Soft satisfying checkbox tick, a short clean UI tap with a tiny pop, dry, no music', seconds: 0.5, source: 'preset', anchor: 'onset' },
  { id: 'toggle', label: 'Toggle switch', prompt: 'Small toggle switch flick, clean modern UI sound, dry, very short, no music', seconds: 0.5, source: 'preset', anchor: 'onset' },
  { id: 'keystroke', label: 'Keystroke', prompt: 'Single soft laptop keyboard key press, close up, dry, very short, no music', seconds: 0.5, source: 'preset', anchor: 'onset' },
  { id: 'pop', label: 'Pop', prompt: 'Soft bubble pop notification, short and clean UI sound, no music', seconds: 0.5, source: 'preset', anchor: 'onset' },
  { id: 'success', label: 'Success chime', prompt: 'Bright pleasant two-note success chime, modern app UI, short, no music', seconds: 1.5, source: 'preset', anchor: 'onset' },
  { id: 'whoosh', label: 'Whoosh', prompt: 'Fast clean airy whoosh transition, short, modern motion graphics, no music', seconds: 1, source: 'preset', anchor: 'peak' },
  { id: 'swoosh', label: 'Card slide', prompt: 'Very short soft swoosh of a card sliding into place, subtle, no music', seconds: 0.6, source: 'preset', anchor: 'peak' },
  { id: 'impact', label: 'Impact', prompt: 'Deep clean cinematic impact hit with a short tail, modern, no music', seconds: 2, source: 'preset', anchor: 'onset' },
  { id: 'riser', label: 'Riser', prompt: 'Short cinematic riser building tension, stops abruptly at the end, no music', seconds: 2, source: 'preset', anchor: 'peak' },
  { id: 'shimmer', label: 'Shimmer', prompt: 'Short magical sparkle shimmer, airy and light, no music', seconds: 1.5, source: 'preset', anchor: 'onset' },
];

/** Older Story.sound() names → library ids. */
const ALIASES: Record<string, string> = { chime: 'success', drop: 'impact', swell: 'riser', typing: 'keystroke' };

export function emptySounds(): SoundsFile {
  return { version: 1, library: PRESETS.map((p) => ({ ...p })), scenes: {}, whooshOnCuts: false, gain: 1 };
}

/** Fills in presets missing from an older file, keeping generated files and edits. */
export function withPresets(file: SoundsFile): SoundsFile {
  const library = [...(file.library ?? [])];
  for (const preset of PRESETS) if (!library.some((s) => s.id === preset.id)) library.push({ ...preset });
  return { ...emptySounds(), ...file, library };
}

function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Every cue in the video, in video time. Automatic cues come from the scenes' reports; muted
 * ones are kept (flagged) so the editor can show them.
 */
export function resolveCues(
  sounds: SoundsFile,
  scenes: { id: string; start: number; duration: number }[],
  reports: Record<string, SceneCueReport[]>,
): ResolvedCue[] {
  const out: ResolvedCue[] = [];
  const library = new Set(sounds.library.map((s) => s.id));
  const label = (id: string) => sounds.library.find((s) => s.id === id)?.label ?? id;

  for (const scene of scenes) {
    const config = sounds.scenes[scene.id] ?? { cues: [] };
    const muted = new Set(config.muted ?? []);
    const push = (cue: Omit<ResolvedCue, 't' | 'scene' | 'muted' | 'label'> & { local: number }) => {
      if (cue.local < 0 || cue.local > scene.duration + 1e-6) return;
      out.push({ ...cue, scene: scene.id, t: scene.start + cue.local, muted: cue.auto && muted.has(cue.id), label: label(cue.sound) });
    };

    for (const report of reports[scene.id] ?? []) {
      const ms = Math.round(report.t * 1000);
      if (report.source === 'helper' && report.type === 'click') {
        push({ id: `auto:${scene.id}:click:${ms}`, local: report.t, sound: 'click', gain: 0.8, pan: 0, rate: 1, auto: true });
      } else if (report.source === 'helper' && report.type === 'typing') {
        // One keystroke per character, timed to when it appears (Story.type is linear by default).
        const chars = Math.max(1, Math.min(400, report.chars ?? Math.round((report.d ?? 1) * 14)));
        const d = report.d ?? chars * 0.045;
        const id = `auto:${scene.id}:typing:${ms}`;
        let seed = hashSeed(id);
        const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0) % 1000) / 1000;
        for (let i = 1; i <= chars; i++) {
          push({ id, local: report.t + (d * i) / chars - 0.01, sound: 'keystroke', gain: 0.45 + rand() * 0.25, pan: (rand() - 0.5) * 0.2, rate: 0.92 + rand() * 0.16, auto: true });
        }
      } else if (report.source === 'scene') {
        const sound = ALIASES[report.type] ?? report.type;
        if (!library.has(sound)) continue;
        push({ id: `auto:${scene.id}:${sound}:${ms}`, local: report.t, sound, gain: report.gain ?? 1, pan: report.pan ?? 0, rate: 1, auto: true });
      }
    }

    for (const cue of config.cues) {
      push({ id: cue.id, local: cue.t, sound: cue.sound, gain: cue.gain ?? 1, pan: cue.pan ?? 0, rate: 1, auto: false });
    }
  }

  if (sounds.whooshOnCuts) {
    for (const scene of scenes.slice(1)) {
      const id = `auto:cut:${scene.id}`;
      const muted = (sounds.scenes[scene.id]?.muted ?? []).includes(id);
      out.push({ id, scene: scene.id, t: scene.start, local: 0, sound: 'whoosh', gain: 0.7, pan: 0, rate: 1, auto: true, muted, label: label('whoosh') });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
