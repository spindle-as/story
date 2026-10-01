/**
 * AI-generated music (ElevenLabs Music).
 *
 * A music plan (projects/<slug>/music.json) is the creative brief: global styles plus one section
 * per scene or group of scenes. Section lengths always come from the scenes themselves, so the
 * music changes where the video cuts. elevenLabsRequest() turns a plan into an API request.
 */
import { fitTempo, MOODS, type Mood, type ScoreSfx } from './score.ts';

export type MusicModel = 'music_v2_5' | 'music_v2' | 'music_v1';

export interface MusicSection {
  /** Consecutive scene ids this section plays under. */
  scenes: string[];
  label: string;
  /** Inline direction for the section, e.g. "{piano motif enters}". */
  text?: string;
  styles: string[];
  avoid?: string[];
}

export interface MusicPlan {
  version: 1;
  provider: 'elevenlabs';
  model: MusicModel;
  mood?: string;
  styles: string[];
  avoid: string[];
  sections: MusicSection[];
  /** Legacy: sound effects now live in sounds.json. */
  sfx?: boolean;
  musicGain?: number;
  sfxGain?: number;
  seed?: number;
}

export interface TimedSection {
  /** Index of the plan section this comes from (-1 for scenes before any section). */
  index: number;
  label: string;
  scenes: string[];
  start: number;
  duration: number;
  text: string;
  styles: string[];
  avoid: string[];
}

const MIN_SECTION = 3;

const MOOD_STYLES: Record<Mood, { styles: string[]; avoid: string[] }> = {
  minimal: {
    styles: ['instrumental', 'minimal modern electronic', 'soft felt piano', 'warm analog synth pads', 'subtle clean percussion', 'optimistic', 'premium product film'],
    avoid: ['vocals', 'singing', 'lyrics', 'distorted', 'aggressive drums', 'cheesy'],
  },
  upbeat: {
    styles: ['instrumental', 'upbeat electronic pop', 'punchy four-on-the-floor kick', 'plucked synth arpeggios', 'bright', 'energetic tech product launch'],
    avoid: ['vocals', 'singing', 'lyrics', 'slow', 'sad', 'cheesy'],
  },
  cinematic: {
    styles: ['instrumental', 'cinematic trailer score', 'wide strings', 'deep percussion', 'tension and release', 'epic but restrained'],
    avoid: ['vocals', 'singing', 'lyrics', 'comedic', 'lo-fi'],
  },
  ambient: {
    styles: ['instrumental', 'ambient', 'glassy bells', 'slow evolving pads', 'spacious reverb', 'calm and thoughtful'],
    avoid: ['vocals', 'singing', 'lyrics', 'drums', 'fast'],
  },
};

const ROLES = {
  intro: { label: 'Intro', text: '[Intro]\n{sparse and quiet, introduce the main motif}', styles: ['sparse', 'soft intro'], avoid: ['full drums'] },
  build: { label: 'Build', text: '[Build]\n{layers enter one by one, rising energy}', styles: ['building', 'rhythm enters'], avoid: [] },
  main: { label: 'Main', text: '[Main theme]\n{full arrangement, confident}', styles: ['full arrangement', 'main theme'], avoid: [] },
  outro: { label: 'Outro', text: '[Outro]\n{resolve the theme and land a final hit on the downbeat}', styles: ['resolving', 'final hit', 'clean ending'], avoid: ['fade in', 'building'] },
};

/** Direction for the second, third… section in a row with the same role, so the music keeps developing. */
const CONTINUATIONS: Record<string, string[]> = {
  Build: ['{keep rising, add a new layer}', '{tension peaks, ready to drop}'],
  Main: ['{variation on the theme, same energy}', '{theme at its fullest}'],
};

interface SceneLike {
  id: string;
  title?: string;
  duration: number;
}

/** Groups scenes so every section is at least 3 seconds (the API minimum). */
function groupScenes(scenes: SceneLike[]): SceneLike[][] {
  const groups: SceneLike[][] = [];
  let current: SceneLike[] = [];
  let length = 0;
  for (const scene of scenes) {
    current.push(scene);
    length += scene.duration;
    if (length >= MIN_SECTION) {
      groups.push(current);
      current = [];
      length = 0;
    }
  }
  if (current.length) {
    if (groups.length) groups[groups.length - 1].push(...current);
    else groups.push(current);
  }
  return groups;
}

export function defaultPlan(scenes: SceneLike[], mood: Mood = 'minimal'): MusicPlan {
  const preset = MOOD_STYLES[mood] ?? MOOD_STYLES.minimal;
  const total = scenes.reduce((s, x) => s + x.duration, 0);
  let acc = 0;
  const cuts = scenes.slice(0, -1).map((s) => (acc += s.duration));
  const range = MOODS[mood]?.bpm ?? MOODS.minimal.bpm;
  const bpm = Math.round(fitTempo(cuts, range[0], range[1], range[2]));

  const groups = groupScenes(scenes);
  let start = 0;
  const sections = groups.map((group, i) => {
    const role =
      groups.length === 1 ? ROLES.main
      : i === 0 ? ROLES.intro
      : i === groups.length - 1 ? ROLES.outro
      : start < total * 0.35 ? ROLES.build
      : ROLES.main;
    start += group.reduce((s, x) => s + x.duration, 0);
    return { scenes: group.map((s) => s.id), label: role.label, text: role.text, styles: [...role.styles], avoid: [...role.avoid] };
  });
  sections.forEach((section, i) => {
    let run = 0;
    for (let j = i - 1; j >= 0 && sections[j].label === section.label; j--) run++;
    const next = CONTINUATIONS[section.label]?.[Math.min(run, 2) - 1];
    if (run > 0 && next) section.text = `${section.text.split('\n')[0]}\n${next}`;
  });

  return {
    version: 1,
    provider: 'elevenlabs',
    model: 'music_v2_5',
    mood,
    styles: [...preset.styles, `${bpm} bpm`],
    avoid: [...preset.avoid],
    sections,
    musicGain: 1,
  };
}

/**
 * Applies a plan to the current scenes: sections keep their direction but take their length
 * from their scenes. Scenes not mentioned join the section before them; empty sections drop out.
 */
export function timeSections(plan: MusicPlan, scenes: SceneLike[]): TimedSection[] {
  const owner = new Map<string, number>();
  plan.sections.forEach((section, i) => section.scenes.forEach((id) => owner.set(id, i)));
  const groups: { section: MusicSection; index: number; scenes: SceneLike[] }[] = [];
  let last = -1;
  for (const scene of scenes) {
    const index = owner.get(scene.id);
    if (index !== undefined && index !== last) {
      groups.push({ section: plan.sections[index], index, scenes: [scene] });
      last = index;
    } else if (groups.length) {
      groups[groups.length - 1].scenes.push(scene);
    } else {
      groups.push({ section: plan.sections[0] ?? { scenes: [], label: 'Main', styles: [] }, index: plan.sections.length ? 0 : -1, scenes: [scene] });
      last = 0;
    }
  }
  // Merge anything under the API minimum into its neighbour.
  for (let i = 0; i < groups.length; i++) {
    const length = groups[i].scenes.reduce((s, x) => s + x.duration, 0);
    if (length < MIN_SECTION && groups.length > 1) {
      const target = i < groups.length - 1 ? i + 1 : i - 1;
      if (target > i) groups[target].scenes.unshift(...groups[i].scenes);
      else groups[target].scenes.push(...groups[i].scenes);
      groups.splice(i, 1);
      i = -1;
    }
  }
  let start = 0;
  return groups.map(({ section, index, scenes: group }) => {
    const duration = group.reduce((s, x) => s + x.duration, 0);
    const out = {
      index,
      label: section.label,
      scenes: group.map((s) => s.id),
      start,
      duration,
      text: section.text?.trim() || `[${section.label}]`,
      styles: section.styles ?? [],
      avoid: section.avoid ?? [],
    };
    start += duration;
    return out;
  });
}

/** The request body for POST https://api.elevenlabs.io/v1/music. */
export function elevenLabsRequest(plan: MusicPlan, scenes: SceneLike[]) {
  const sections = timeSections(plan, scenes);
  const totalMs = Math.round(sections.reduce((s, x) => s + x.duration, 0) * 1000);
  // Round each section, giving the rounding remainder to the last one so the total is exact.
  const ms = sections.map((s) => Math.round(s.duration * 1000));
  if (ms.length) ms[ms.length - 1] += totalMs - ms.reduce((a, b) => a + b, 0);
  const clean = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, 30);

  const body: Record<string, unknown> =
    plan.model === 'music_v1'
      ? {
          model_id: 'music_v1',
          composition_plan: {
            positive_global_styles: clean(plan.styles),
            negative_global_styles: clean(plan.avoid),
            sections: sections.map((s, i) => ({
              section_name: s.label,
              positive_local_styles: clean(s.styles),
              negative_local_styles: clean(s.avoid),
              duration_ms: ms[i],
              lines: [],
            })),
          },
          respect_sections_durations: true,
        }
      : {
          model_id: plan.model,
          composition_plan: {
            chunks: sections.map((s, i) => ({
              text: s.text,
              duration_ms: ms[i],
              positive_styles: clean([...plan.styles, ...s.styles]),
              negative_styles: clean([...plan.avoid, ...s.avoid]),
              context_adherence: 'high',
            })),
          },
        };
  if (plan.seed !== undefined) body.seed = plan.seed;
  return { body, sections, totalSeconds: totalMs / 1000 };
}

/** Sound effects that follow the edit: a whoosh on each cut, and a riser plus a hit into the last scene. */
export function cutSfx(cuts: number[], duration: number): ScoreSfx[] {
  const inner = cuts.filter((c) => c > 0.2 && c < duration - 0.2);
  const out: ScoreSfx[] = [];
  inner.forEach((c, i) => {
    const last = i === inner.length - 1 && inner.length >= 2;
    out.push({ t: c, type: 'whoosh', gain: 0.32 });
    if (last) {
      out.push({ t: c, type: 'riser', d: 1.6, gain: 0.25 });
      out.push({ t: c, type: 'impact', gain: 0.45 });
    }
  });
  return out;
}

/** Prompts and lengths for generating each sound effect once with ElevenLabs. */
export const SFX_PROMPTS: Record<string, { text: string; seconds: number }> = {
  whoosh: { text: 'Fast clean cinematic whoosh transition, airy, modern motion graphics swoosh, no music', seconds: 1 },
  swoosh: { text: 'Short subtle UI swoosh transition, soft and clean, no music', seconds: 0.6 },
  riser: { text: 'Short cinematic tension riser that builds and stops abruptly, no music', seconds: 2 },
  swell: { text: 'Reverse cymbal swell building into a hit, no music', seconds: 2 },
  impact: { text: 'Deep cinematic impact hit with a short clean reverb tail, modern trailer boom, no music', seconds: 2.5 },
  drop: { text: 'Smooth sub bass drop, cinematic, no music', seconds: 1.5 },
  click: { text: 'Single soft crisp mouse click, clean UI sound, no music', seconds: 0.5 },
  tick: { text: 'Single soft laptop keyboard key press, no music', seconds: 0.5 },
  typing: { text: 'Fast steady typing on a quiet modern laptop keyboard, close up, no music', seconds: 4 },
  pop: { text: 'Soft bubble pop UI notification sound, no music', seconds: 0.5 },
  shimmer: { text: 'Short magical shimmer sparkle, airy chime, no music', seconds: 1.5 },
  chime: { text: 'Bright clean success chime, two quick notes, modern UI, no music', seconds: 1.5 },
};
