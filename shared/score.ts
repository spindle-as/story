/**
 * Soundtrack scores.
 *
 * A score (projects/<slug>/score.json) describes music in musical terms: tempo, key, a chord
 * progression and instrument tracks that play patterns over that progression, plus sound effects
 * at exact video times. compileScore() turns it into a flat list of timed synth events, which
 * runtime/synth.js renders to audio. Everything is deterministic, so a score always renders the same.
 */

export const INSTRUMENTS = [
  'pad', 'strings', 'keys', 'pluck', 'bell', 'lead', 'bass', 'sub',
  'kick', 'snare', 'clap', 'rim', 'hat', 'openhat', 'shaker', 'tom',
] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export const PERCUSSION: ReadonlySet<string> = new Set(['kick', 'snare', 'clap', 'rim', 'hat', 'openhat', 'shaker', 'tom']);

export const SFX = [
  'whoosh', 'swoosh', 'riser', 'impact', 'drop', 'click', 'tick', 'typing', 'pop', 'swell', 'shimmer', 'chime',
] as const;
export type SfxType = (typeof SFX)[number];

const DEFAULT_OCTAVE: Record<string, number> = {
  pad: 3, strings: 3, keys: 4, pluck: 4, bell: 5, lead: 5, bass: 2, sub: 2,
};

export interface ScoreNote {
  /** Beat from the start of the song (0 = first downbeat). */
  beat: number;
  /** Note name ("F#4"), MIDI number, or several for a chord. */
  n: string | number | (string | number)[];
  /** Length in beats (default 1). */
  len?: number;
  v?: number;
}

export interface ScoreTrack {
  name?: string;
  instrument: Instrument;
  /** A keyword (chord, arp-8, root-4…) or a step string ("x...x...", "1.3.5-.."). See docs in prompt.ts. */
  pattern?: string;
  /** Step size for step-string patterns: 16 = sixteenths (default), 8 = eighths, 4 = quarters. */
  step?: 4 | 8 | 16;
  notes?: ScoreNote[];
  /** Bars where the track plays: [from, to) or a list of ranges. Default: the whole song. */
  bars?: [number, number] | [number, number][];
  octave?: number;
  gain?: number;
  v?: number;
  pan?: number;
  /** Reverb send, 0–1. */
  reverb?: number;
}

export interface ScoreSfx {
  /** Seconds from the start of the video. For risers and swells this is when they peak. */
  t: number;
  type: SfxType;
  /** Length in seconds (sensible default per type). */
  d?: number;
  gain?: number;
  pan?: number;
  reverb?: number;
  /** For typing: number of keystrokes. */
  chars?: number;
}

export interface Score {
  version: 1;
  mood?: string;
  bpm: number;
  /** Seconds before the first downbeat (default 0). */
  offset?: number;
  beatsPerBar?: number;
  key: string;
  scale: keyof typeof SCALES;
  /** Progression, cycled: roman numerals (I, vi, IV, bVII, V7, IVsus2…). */
  chords: string[];
  /** Bars per chord (default 1). */
  chordBars?: number;
  tracks: ScoreTrack[];
  sfx?: ScoreSfx[];
  /** Include the sounds scenes declare (Story.sound) and helper sounds (clicks, typing). Default true. */
  sceneSounds?: boolean;
  master?: { gain?: number; reverb?: number; fadeIn?: number; fadeOut?: number };
}

export interface SynthEvent {
  kind: 'note' | 'sfx';
  /** Instrument or sfx type. */
  type: string;
  t: number;
  d: number;
  midi?: number;
  v: number;
  pan: number;
  reverb: number;
  seed: number;
}

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
} as const;

const PITCH: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

export function pitchClass(key: string): number {
  const pc = PITCH[key.trim().replace(/m(in(or)?)?$/i, '')];
  if (pc === undefined) throw new Error(`Unknown key "${key}"`);
  return pc;
}

/** "C4" → 60. Numbers pass through. */
export function noteToMidi(n: string | number): number {
  if (typeof n === 'number') return n;
  const m = n.trim().match(/^([A-Ga-g])([#b]?)(-?\d)$/);
  if (!m) throw new Error(`Unknown note "${n}"`);
  return PITCH[m[1].toUpperCase() + m[2]] + 12 * (Number(m[3]) + 1);
}

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];

/** Chord tones as semitones above the key's root, ascending. */
export function chordTones(symbol: string, scaleName: keyof typeof SCALES): number[] {
  const scale = SCALES[scaleName] ?? SCALES.major;
  const m = symbol.trim().match(/^(b|#)?(vii|iii|vi|iv|ii|v|i|[1-7])(°|o|\+)?(maj7|7|sus2|sus4|add9|9)?$/i);
  if (!m) throw new Error(`Unknown chord "${symbol}"`);
  const degree = /\d/.test(m[2]) ? Number(m[2]) - 1 : ROMAN.indexOf(m[2].toLowerCase());
  const at = (step: number) => scale[step % 7] + 12 * Math.floor(step / 7);
  let tones: number[];
  if (m[1]) {
    // Borrowed chord (bVII, bVI…): a major triad on the altered root.
    const root = at(degree) + (m[1] === 'b' ? -1 : 1);
    tones = [root, root + 4, root + 7];
  } else {
    tones = [at(degree), at(degree + 2), at(degree + 4)];
  }
  switch (m[4]?.toLowerCase()) {
    case '7': tones.push(m[1] ? tones[0] + 10 : at(degree + 6)); break;
    case 'maj7': tones.push(tones[0] + 11); break;
    case 'sus2': tones[1] = m[1] ? tones[0] + 2 : at(degree + 1); break;
    case 'sus4': tones[1] = m[1] ? tones[0] + 5 : at(degree + 3); break;
    case 'add9':
    case '9': tones.push(tones[0] + 14); break;
  }
  return tones;
}

/** Seeded PRNG (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function beatGrid(score: Pick<Score, 'bpm' | 'offset' | 'beatsPerBar'>, duration: number) {
  const beat = 60 / score.bpm;
  const per = score.beatsPerBar ?? 4;
  const beats: number[] = [];
  const downbeats: number[] = [];
  for (let i = 0, t = score.offset ?? 0; t <= duration + 1e-6; i++, t = (score.offset ?? 0) + i * beat) {
    const time = Number(t.toFixed(4));
    beats.push(time);
    if (i % per === 0) downbeats.push(time);
  }
  return { beats, downbeats };
}

const ranges = (bars: ScoreTrack['bars'], total: number): [number, number][] => {
  if (!bars) return [[0, total]];
  const list = typeof bars[0] === 'number' ? [bars as [number, number]] : (bars as [number, number][]);
  return list.map(([a, b]) => [Math.max(0, a), Math.min(total, b ?? total)] as [number, number]).filter(([a, b]) => b > a);
};

/** Turns a score into timed synth events. Sounds declared by scenes are passed in already in video time. */
export function compileScore(score: Score, opts: { duration: number; sceneSfx?: ScoreSfx[] }) {
  const warnings: string[] = [];
  const events: SynthEvent[] = [];
  const beatSec = 60 / score.bpm;
  const per = score.beatsPerBar ?? 4;
  const offset = score.offset ?? 0;
  const barSec = beatSec * per;
  const totalBars = Math.max(1, Math.ceil((opts.duration - offset) / barSec));
  const key = pitchClass(score.key);
  const chordBars = Math.max(1, score.chordBars ?? 1);
  const time = (beat: number) => offset + beat * beatSec;
  let seed = 1;

  const progression = score.chords.map((symbol) => {
    try {
      return chordTones(symbol, score.scale);
    } catch (e) {
      warnings.push((e as Error).message);
      return chordTones('I', score.scale);
    }
  });
  const chordAt = (bar: number) => progression[Math.floor(bar / chordBars) % progression.length];

  const push = (track: ScoreTrack, beat: number, len: number, midi: number | undefined, v: number) => {
    const t = time(beat);
    if (t >= opts.duration || t < 0) return;
    events.push({
      kind: 'note',
      type: track.instrument,
      t,
      d: Math.max(0.02, Math.min(len * beatSec, opts.duration - t + 2)),
      midi,
      v: v * (track.v ?? 1) * (track.gain ?? 0.5),
      pan: track.pan ?? 0,
      reverb: track.reverb ?? (PERCUSSION.has(track.instrument) ? 0.08 : 0.3),
      seed: seed++,
    });
  };

  for (const track of score.tracks) {
    if (!INSTRUMENTS.includes(track.instrument)) {
      warnings.push(`Unknown instrument "${track.instrument}". Use one of: ${INSTRUMENTS.join(', ')}`);
      continue;
    }
    const percussive = PERCUSSION.has(track.instrument);
    const octave = track.octave ?? DEFAULT_OCTAVE[track.instrument] ?? 4;
    // Voice chords around the track's octave: roots above F# drop an octave to stay centred.
    const voice = (tones: number[]) => {
      const base = 12 * (octave + 1) + key;
      const shift = key + tones[0] >= 7 ? -12 : 0;
      return tones.map((tone) => base + tone + shift);
    };
    const extended = (tones: number[]) => {
      const v = voice(tones);
      return [...v, ...v.map((m) => m + 12), ...v.map((m) => m + 24)];
    };

    for (const n of track.notes ?? []) {
      const list = Array.isArray(n.n) ? n.n : [n.n];
      for (const note of list) {
        try {
          push(track, n.beat, n.len ?? 1, percussive ? undefined : noteToMidi(note), n.v ?? 0.8);
        } catch (e) {
          warnings.push((e as Error).message);
        }
      }
    }

    const pattern = track.pattern?.trim();
    if (!pattern) continue;
    for (const [from, to] of ranges(track.bars, totalBars)) {
      const endBeat = to * per;
      if (/^[xXo.\-|]+$/.test(pattern) || /^[0-9.\-|]+$/.test(pattern)) {
        // Step string.
        const steps = pattern.replace(/\|/g, '');
        const stepBeats = 4 / (track.step ?? 16);
        for (let beat = from * per, i = 0; beat < endBeat - 1e-9; beat += stepBeats, i++) {
          const c = steps[i % steps.length];
          if (c === '.' || c === '-') continue;
          let len = stepBeats;
          for (let j = i + 1; steps[j % steps.length] === '-' && beat + (j - i) * stepBeats < endBeat; j++) len += stepBeats;
          if (percussive || /[xXo]/.test(c)) {
            push(track, beat, len, undefined, c === 'X' ? 1 : c === 'o' ? 0.5 : 0.8);
          } else {
            const bar = Math.floor(beat / per);
            const tones = extended(chordAt(bar));
            push(track, beat, len * 0.95, tones[(Number(c) - 1 + tones.length) % tones.length], 0.8);
          }
        }
        continue;
      }
      if (percussive) {
        warnings.push(`${track.instrument} needs a step pattern like "x...x...x...x...", not "${pattern}"`);
        break;
      }
      const [kind, arg, dir] = pattern.split('-');
      for (let bar = from; bar < to; bar++) {
        const tones = voice(chordAt(bar));
        const startBeat = bar * per;
        const changes = bar % chordBars === 0 || bar === from;
        switch (kind) {
          case 'chord': {
            if (!arg) {
              if (!changes) break;
              const bars = Math.min(chordBars - (bar % chordBars), to - bar);
              tones.forEach((m) => push(track, startBeat, bars * per, m, 0.7));
            } else if (arg === 'off') {
              for (let b = 0.5; b < per; b += 1) tones.forEach((m) => push(track, startBeat + b, 0.4, m, 0.7));
            } else {
              const every = Number(arg) === 2 ? per / 2 : 1;
              for (let b = 0; b < per; b += every) tones.forEach((m) => push(track, startBeat + b, every * 0.9, m, 0.7));
            }
            break;
          }
          case 'root':
          case 'pedal': {
            const root = tones[0] - (track.instrument === 'pad' || track.instrument === 'strings' ? 12 : 0);
            if (!arg || kind === 'pedal') {
              if (!changes) break;
              const bars = Math.min(chordBars - (bar % chordBars), to - bar);
              push(track, startBeat, bars * per, root, 0.8);
            } else if (arg === 'off') {
              for (let b = 0.5; b < per; b += 1) push(track, startBeat + b, 0.45, root, 0.8);
            } else if (arg === 'fifth') {
              for (let b = 0; b < per; b += 1) push(track, startBeat + b, 0.9, b % 2 ? root + 7 : root, 0.8);
            } else {
              const step = 4 / Number(arg);
              if (!Number.isFinite(step) || step <= 0) {
                warnings.push(`Unknown pattern "${pattern}"`);
                break;
              }
              for (let b = 0; b < per; b += step) push(track, startBeat + b, step * 0.9, root, b === 0 ? 0.9 : 0.75);
            }
            break;
          }
          case 'arp': {
            const step = arg === '16' ? 0.25 : arg === '4' ? 1 : 0.5;
            const up = [...tones, tones[0] + 12];
            const seq = dir === 'down' ? [...up].reverse() : dir === 'updown' ? [...up, ...up.slice(1, -1).reverse()] : up;
            for (let b = 0, i = 0; b < per - 1e-9; b += step, i++) push(track, startBeat + b, step * 0.95, seq[i % seq.length], i % seq.length === 0 ? 0.85 : 0.7);
            break;
          }
          default:
            warnings.push(`Unknown pattern "${pattern}"`);
            bar = to;
        }
      }
    }
  }

  const sfx = [...(score.sfx ?? []), ...(score.sceneSounds === false ? [] : (opts.sceneSfx ?? []))];
  const compiled = compileSfx(sfx, opts.duration, { firstSeed: seed });
  events.push(...compiled.events);
  warnings.push(...compiled.warnings);

  events.sort((a, b) => a.t - b.t);
  return { events, warnings, ...beatGrid(score, opts.duration), totalBars };
}

// ---------------------------------------------------------------------------
// Tempo fitting and the automatic composer

/** Picks the tempo in [lo, hi] that puts the cuts closest to beats, preferring `prefer`. */
export function fitTempo(cuts: number[], lo: number, hi: number, prefer: number) {
  let best = { bpm: prefer, score: Infinity };
  for (let bpm = lo; bpm <= hi + 1e-9; bpm += 0.25) {
    const beat = 60 / bpm;
    let err = 0;
    for (const c of cuts) {
      const toBeat = Math.abs(c - Math.round(c / beat) * beat);
      const toHalf = Math.abs(c - Math.round(c / (beat / 2)) * (beat / 2)) + 0.015;
      err += Math.min(toBeat, toHalf);
    }
    const score = (cuts.length ? err / cuts.length : 0) + 0.0015 * Math.abs(bpm - prefer);
    if (score < best.score) best = { bpm, score };
  }
  return Number(best.bpm.toFixed(2));
}

/** How far each cut is from the nearest beat, in milliseconds (negative = cut comes early). */
export function cutAlignment(cuts: number[], bpm: number, offset = 0) {
  const beat = 60 / bpm;
  return cuts.map((t) => {
    const nearest = offset + Math.round((t - offset) / beat) * beat;
    return { t, beat: Math.round((t - offset) / beat), ms: Math.round((t - nearest) * 1000) };
  });
}

export type Mood = 'minimal' | 'upbeat' | 'cinematic' | 'ambient';

export const MOODS: Record<Mood, { label: string; description: string; bpm: [number, number, number]; key: string; scale: keyof typeof SCALES; chords: string[]; chordBars: number; reverb: number }> = {
  minimal: {
    label: 'Minimal',
    description: 'Soft keys over an airy pad, light percussion. Calm and precise, like an Apple keynote.',
    bpm: [96, 112, 104], key: 'D', scale: 'major', chords: ['I', 'V', 'vi', 'IVadd9'], chordBars: 1, reverb: 0.32,
  },
  upbeat: {
    label: 'Upbeat',
    description: 'Four-on-the-floor kick, plucked arpeggios and an offbeat bass. Energetic product launch.',
    bpm: [116, 128, 122], key: 'A', scale: 'minor', chords: ['i', 'VI', 'III', 'VII'], chordBars: 1, reverb: 0.2,
  },
  cinematic: {
    label: 'Cinematic',
    description: 'Wide strings, low drums, risers and impacts on the cuts. Big reveal energy.',
    bpm: [80, 96, 88], key: 'C', scale: 'minor', chords: ['i', 'VI', 'III', 'VII'], chordBars: 1, reverb: 0.4,
  },
  ambient: {
    label: 'Ambient',
    description: 'Slow-moving pad and glassy bells, no drums. Thoughtful and spacious.',
    bpm: [68, 84, 76], key: 'E', scale: 'major', chords: ['Imaj7', 'IV', 'vi7', 'IVadd9'], chordBars: 2, reverb: 0.55,
  },
};

export interface ComposeInput {
  /** Scene boundaries in video seconds, excluding 0 and the end. */
  cuts: number[];
  duration: number;
  mood: Mood;
  bpm?: number;
  key?: string;
  sfx?: boolean;
}

/** A complete starting score, arranged around the scenes: intro, build, peak, outro. */
export function composeScore(input: ComposeInput): Score {
  const mood = MOODS[input.mood] ?? MOODS.minimal;
  const bpm = input.bpm ?? fitTempo(input.cuts, mood.bpm[0], mood.bpm[1], mood.bpm[2]);
  const barSec = (60 / bpm) * 4;
  const total = Math.max(1, Math.ceil(input.duration / barSec));
  const barAt = (t: number) => Math.min(total, Math.max(0, Math.round(t / barSec)));

  const cuts = input.cuts.filter((c) => c > 0.2 && c < input.duration - 0.2);
  const intro = cuts.length ? Math.max(1, barAt(cuts[0])) : Math.min(2, total);
  const outro = cuts.length >= 2 ? Math.max(intro, barAt(cuts.at(-1)!)) : total;
  const peakCut = cuts.find((c) => c >= input.duration * 0.35) ?? cuts[0];
  const peak = peakCut !== undefined ? Math.min(outro, Math.max(intro, barAt(peakCut))) : intro;
  const build: [number, number] = [intro, outro];
  const drums: [number, number] = [peak, outro];

  const tracks: ScoreTrack[] = [];
  const add = (track: ScoreTrack) => {
    const r = track.bars as [number, number] | undefined;
    if (!r || r[1] > r[0]) tracks.push(track);
  };
  switch (input.mood) {
    case 'upbeat':
      add({ name: 'Pad', instrument: 'pad', pattern: 'chord', gain: 0.22 });
      add({ name: 'Arp', instrument: 'pluck', pattern: 'arp-16', gain: 0.2, bars: [0, outro], pan: 0.15 });
      add({ name: 'Bass', instrument: 'bass', pattern: 'root-off', gain: 0.34, bars: build });
      add({ name: 'Hats', instrument: 'hat', pattern: '..x...x...x...x.', gain: 0.22, bars: build, pan: -0.2 });
      add({ name: 'Kick', instrument: 'kick', pattern: 'x...x...x...x...', gain: 0.6, bars: drums });
      add({ name: 'Clap', instrument: 'clap', pattern: '....x.......x...', gain: 0.32, bars: drums });
      add({ name: 'Bell', instrument: 'bell', pattern: 'arp-8', gain: 0.18, bars: [outro, Math.min(total, outro + 1)] });
      break;
    case 'cinematic':
      add({ name: 'Strings', instrument: 'strings', pattern: 'chord', gain: 0.36 });
      add({ name: 'Low end', instrument: 'sub', pattern: 'pedal', gain: 0.22, bars: [intro, total] });
      add({ name: 'Motif', instrument: 'bell', pattern: '1.......3...2...', step: 16, gain: 0.16, bars: build });
      add({ name: 'Drums', instrument: 'tom', pattern: 'x.......x..x....', gain: 0.55, bars: drums });
      add({ name: 'Pulse', instrument: 'bass', pattern: 'root-8', gain: 0.2, bars: drums });
      break;
    case 'ambient':
      add({ name: 'Pad', instrument: 'pad', pattern: 'chord', gain: 0.4 });
      add({ name: 'Bells', instrument: 'bell', pattern: '1.......5.......3...............', gain: 0.18, reverb: 0.7 });
      add({ name: 'Sub', instrument: 'sub', pattern: 'pedal', gain: 0.18, bars: build });
      add({ name: 'Keys', instrument: 'keys', pattern: 'arp-4', gain: 0.12, bars: drums });
      break;
    default:
      add({ name: 'Pad', instrument: 'pad', pattern: 'chord', gain: 0.3 });
      add({ name: 'Keys', instrument: 'keys', pattern: 'arp-8', gain: 0.2, bars: [0, outro], pan: 0.1 });
      add({ name: 'Sub', instrument: 'sub', pattern: 'root', gain: 0.22, bars: build });
      add({ name: 'Shaker', instrument: 'shaker', pattern: '..x...x...x...x.', gain: 0.16, bars: build, pan: 0.25 });
      add({ name: 'Kick', instrument: 'kick', pattern: 'x.......x.......', gain: 0.42, bars: drums });
      add({ name: 'Rim', instrument: 'rim', pattern: '....x.......x...', gain: 0.18, bars: drums, pan: -0.15 });
      add({ name: 'Bell', instrument: 'bell', pattern: 'arp-8', gain: 0.2, bars: [outro, Math.min(total, outro + 1)] });
  }

  const sfx: ScoreSfx[] = [];
  if (input.sfx !== false) {
    cuts.forEach((c, i) => {
      const last = i === cuts.length - 1 && cuts.length >= 2;
      if (input.mood === 'ambient') sfx.push({ t: c, type: 'shimmer', gain: 0.25 });
      else sfx.push({ t: c, type: 'whoosh', gain: input.mood === 'upbeat' ? 0.3 : 0.35 });
      if (input.mood === 'cinematic' && !last) sfx.push({ t: c, type: 'impact', gain: 0.3 });
      if (last) {
        sfx.push({ t: c, type: 'riser', d: Math.min(2, barSec), gain: 0.28 });
        sfx.push({ t: c, type: input.mood === 'ambient' ? 'chime' : 'impact', gain: input.mood === 'minimal' ? 0.35 : 0.5 });
      }
    });
  }

  return {
    version: 1,
    mood: input.mood,
    bpm,
    offset: 0,
    beatsPerBar: 4,
    key: input.key ?? mood.key,
    scale: mood.scale,
    chords: mood.chords,
    chordBars: mood.chordBars,
    tracks,
    sfx,
    sceneSounds: input.sfx !== false,
    master: { gain: 0.9, reverb: mood.reverb, fadeIn: 0.05, fadeOut: 1.5 },
  };
}

/**
 * Sound effects → synth events. Typing becomes individual keystrokes unless `expandTyping` is
 * false (when a recorded typing sample will play instead).
 */
export function compileSfx(sfx: ScoreSfx[], duration: number, opts: { expandTyping?: boolean; firstSeed?: number } = {}) {
  const events: SynthEvent[] = [];
  const warnings: string[] = [];
  let seed = opts.firstSeed ?? 1;
  for (const s of sfx) {
    if (!SFX.includes(s.type)) {
      warnings.push(`Unknown sound "${s.type}". Use one of: ${SFX.join(', ')}`);
      continue;
    }
    const base = { kind: 'sfx' as const, pan: s.pan ?? 0, reverb: s.reverb ?? 0.2 };
    if (s.type === 'typing' && opts.expandTyping !== false) {
      // Expand into individual keystrokes with a little human timing.
      const d = s.d ?? 1;
      const count = Math.max(1, Math.min(200, Math.round(s.chars ?? d * 14)));
      const rand = prng(Math.round(s.t * 1000) + count);
      for (let i = 0; i < count; i++) {
        const t = s.t + (d * i) / count + (rand() - 0.5) * (d / count) * 0.5;
        if (t < duration) events.push({ ...base, type: 'tick', t: Math.max(0, t), d: 0.03, v: (s.gain ?? 0.35) * (0.6 + rand() * 0.4), pan: (rand() - 0.5) * 0.3, seed: seed++ });
      }
      continue;
    }
    if (s.t < duration + 0.5) {
      events.push({ ...base, type: s.type, t: s.t, d: s.d ?? 0, v: s.gain ?? 0.5, seed: seed++ });
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { events, warnings };
}
