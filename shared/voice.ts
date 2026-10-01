/**
 * Voice-over: a narration script placed on the timeline and spoken by an ElevenLabs voice.
 *
 * projects/<slug>/voiceover.json holds the voice, the model and the lines. Each line belongs to a
 * scene and starts at a scene time, so it moves with its scene. Generated audio keeps per-word
 * timings, used for captions and so scenes can be timed to the words.
 */

export interface VoiceWord {
  w: string;
  /** Seconds from the start of the line's audio. */
  s: number;
  e: number;
}

export interface VoiceLine {
  id: string;
  scene: string;
  /** Seconds from the start of the scene. */
  t: number;
  text: string;
  note?: string;
  file?: string;
  duration?: number;
  /** Fingerprint of what the audio was generated from; a mismatch means it's outdated. */
  hash?: string;
  words?: VoiceWord[];
}

export interface VoiceSettings {
  stability: number;
  similarity: number;
  style: number;
  speed: number;
}

export interface VoiceoverFile {
  version: 1;
  voice: { id: string; name: string } | null;
  model: string;
  settings: VoiceSettings;
  /** Direction for the read, used when writing the script (not sent to ElevenLabs). */
  direction?: string;
  lines: VoiceLine[];
  /** Voice level, 0–2. */
  gain: number;
  /** Music level while the voice speaks (0–1). */
  duck: number;
  captions: boolean;
}

export const VOICE_MODELS = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 · natural and consistent', stitching: true },
  { id: 'eleven_v3', label: 'v3 · most expressive', stitching: false },
  { id: 'eleven_v4', label: 'v4 · emotive, highest quality', stitching: false },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 · fast and cheap', stitching: true },
];

/** Narration pace used for word budgets: about 2.5 words per second for a calm product read. */
export const WORDS_PER_SECOND = 2.5;

export function emptyVoiceover(): VoiceoverFile {
  return {
    version: 1,
    voice: null,
    model: 'eleven_multilingual_v2',
    settings: { stability: 0.5, similarity: 0.75, style: 0.15, speed: 1 },
    direction: 'Warm, confident and unhurried, like an Apple product film. Short sentences.',
    lines: [],
    gain: 1,
    duck: 0.35,
    captions: true,
  };
}

/** FNV-1a, enough to notice that a line's text, voice or settings changed. */
export function lineHash(line: Pick<VoiceLine, 'text'>, vo: Pick<VoiceoverFile, 'voice' | 'model' | 'settings'>) {
  const input = JSON.stringify([line.text.trim(), vo.voice?.id, vo.model, vo.settings]);
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Words that comfortably fit in `seconds` of narration. */
export const wordBudget = (seconds: number) => Math.max(0, Math.floor((seconds - 0.3) * WORDS_PER_SECOND));

export interface ResolvedLine extends VoiceLine {
  /** Video seconds. */
  start: number;
  /** Video seconds; estimated from the word count when not generated yet. */
  end: number;
  estimated: boolean;
  stale: boolean;
  /** Seconds available before the next line or the end of the video. */
  room: number;
  issues: string[];
}

export function resolveLines(vo: VoiceoverFile, scenes: { id: string; start: number; duration: number }[]): ResolvedLine[] {
  const total = scenes.reduce((s, x) => Math.max(s, x.start + x.duration), 0);
  const placed = vo.lines
    .map((line) => {
      const scene = scenes.find((s) => s.id === line.scene);
      if (!scene) return null;
      const start = scene.start + line.t;
      const estimated = !line.file || !line.duration;
      const length = estimated ? wordCount(line.text) / WORDS_PER_SECOND + 0.2 : line.duration!;
      return { ...line, start, end: start + length, estimated, stale: !!line.file && line.hash !== lineHash(line, vo), room: 0, issues: [] as string[] };
    })
    .filter((l): l is ResolvedLine => !!l)
    .sort((a, b) => a.start - b.start);

  placed.forEach((line, i) => {
    const next = placed[i + 1];
    line.room = (next ? next.start : total) - line.start;
    const over = line.end - line.start - line.room;
    if (!line.text.trim()) line.issues.push('Empty line');
    if (over > 0.05) {
      line.issues.push(
        next
          ? `${line.estimated ? 'Probably runs' : 'Runs'} ${over.toFixed(1)}s into the next line; cut about ${Math.ceil(over * WORDS_PER_SECOND)} words or start it earlier`
          : `${line.estimated ? 'Probably runs' : 'Runs'} ${over.toFixed(1)}s past the end of the video`,
      );
    }
  });
  return placed;
}

/** Music dips under the voice: merged ranges with a short lead-in and release. */
export function duckRanges(lines: { start: number; end: number }[], lead = 0.2, release = 0.35) {
  const ranges: [number, number][] = [];
  for (const l of [...lines].sort((a, b) => a.start - b.start)) {
    const r: [number, number] = [Math.max(0, l.start - lead), l.end + release];
    const last = ranges.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else ranges.push(r);
  }
  return ranges;
}

const srtTime = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
};

/** Captions from the spoken words: short chunks that break at punctuation, at most 7 words or 3.2s. */
export function toSrt(lines: ResolvedLine[]) {
  const cues: { start: number; end: number; text: string }[] = [];
  for (const line of lines) {
    if (!line.words?.length) {
      if (line.text.trim()) cues.push({ start: line.start, end: line.end, text: line.text.trim() });
      continue;
    }
    let chunk: VoiceWord[] = [];
    const flush = () => {
      if (!chunk.length) return;
      cues.push({ start: line.start + chunk[0].s, end: line.start + chunk.at(-1)!.e, text: chunk.map((w) => w.w).join(' ') });
      chunk = [];
    };
    for (const word of line.words) {
      chunk.push(word);
      const long = chunk.length >= 7 || chunk.at(-1)!.e - chunk[0].s > 3.2;
      // Break at sentence ends; at commas only once the chunk is long enough to read on its own.
      if (long || /[.!?;:]$/.test(word.w) || (/,$/.test(word.w) && chunk.length >= 4)) flush();
    }
    flush();
  }
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(Math.max(c.end, c.start + 0.6))}\n${c.text}\n`).join('\n');
}

/** Groups ElevenLabs' per-character alignment into words. */
export function wordsFromAlignment(alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): VoiceWord[] {
  const words: VoiceWord[] = [];
  let current: VoiceWord | null = null;
  alignment.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = null;
      return;
    }
    const s = alignment.character_start_times_seconds[i];
    const e = alignment.character_end_times_seconds[i];
    if (!current) current = { w: ch, s, e };
    else {
      current.w += ch;
      current.e = e;
    }
  });
  if (current) words.push(current);
  return words.map((w) => ({ ...w, s: Number(w.s.toFixed(3)), e: Number(w.e.toFixed(3)) }));
}
