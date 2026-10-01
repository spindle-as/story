import type { ResolvedCue } from '../../shared/sound';

interface Sample {
  buffer: AudioBuffer;
  onset: number;
  peak: number;
  norm: number;
}

/**
 * Live preview of the soundtrack: the music bed plus every sound cue, scheduled on the Web Audio
 * clock so cues land on the exact frame. Edits to cues are heard on the next play, with no mixing.
 * The export uses the same cue list and anchors (see server/sound.ts), so preview matches export.
 */
export class AudioEngine {
  #ctx: AudioContext | null = null;
  #bed: { buffer: AudioBuffer; offset: number } | null = null;
  #bedUrl: string | null = null;
  #samples = new Map<string, Sample>();
  #sampleUrls = new Map<string, string>();
  #anchors: Record<string, 'onset' | 'peak'> = {};
  #cues: ResolvedCue[] = [];
  #gain = 1;
  #voice: { id: string; url: string; start: number }[] = [];
  #voiceBuffers = new Map<string, AudioBuffer>();
  #voiceGain = 1;
  #duck: { ranges: [number, number][]; level: number } = { ranges: [], level: 1 };
  #sources: AudioScheduledSourceNode[] = [];
  #startedAt = 0;
  #startVideo = 0;
  running = false;

  get ctx() {
    this.#ctx ??= new AudioContext({ latencyHint: 'interactive' });
    return this.#ctx;
  }

  async #decode(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  async setBed(url: string | null, offset = 0) {
    if (url === this.#bedUrl) {
      if (this.#bed) this.#bed.offset = offset;
      return;
    }
    this.#bedUrl = url;
    this.#bed = null;
    if (!url) return;
    try {
      const buffer = await this.#decode(url);
      if (this.#bedUrl === url) this.#bed = { buffer, offset };
    } catch (e) {
      console.error('Could not load music', e);
    }
  }

  /** id → url of every sound with a recording; only changed urls are fetched again. */
  async setSamples(urls: Record<string, string>, anchors: Record<string, 'onset' | 'peak'>) {
    this.#anchors = anchors;
    for (const id of [...this.#samples.keys()]) if (!urls[id]) this.#samples.delete(id);
    await Promise.all(
      Object.entries(urls).map(async ([id, url]) => {
        if (this.#sampleUrls.get(id) === url && this.#samples.has(id)) return;
        try {
          const buffer = await this.#decode(url);
          this.#samples.set(id, { buffer, ...measure(buffer) });
          this.#sampleUrls.set(id, url);
        } catch (e) {
          console.error('Could not load sound', id, e);
        }
      }),
    );
  }

  /** Recorded voice-over lines (video time) and how far the music dips under them. */
  async setVoice(lines: { id: string; url: string; start: number }[], gain: number, duck: { ranges: [number, number][]; level: number }) {
    this.#voice = lines;
    this.#voiceGain = gain;
    this.#duck = duck;
    const wanted = new Set(lines.map((l) => l.url));
    for (const url of [...this.#voiceBuffers.keys()]) if (!wanted.has(url)) this.#voiceBuffers.delete(url);
    await Promise.all(
      lines.map(async (l) => {
        if (this.#voiceBuffers.has(l.url)) return;
        try {
          this.#voiceBuffers.set(l.url, await this.#decode(l.url));
        } catch (e) {
          console.error('Could not load voice line', l.id, e);
        }
      }),
    );
  }

  setCues(cues: ResolvedCue[], gain = 1) {
    this.#cues = cues.filter((c) => !c.muted);
    this.#gain = gain;
  }

  /** Plays from `from` (video seconds); cues after `until` are left out (scene loops). */
  start(from: number, until = Infinity) {
    this.stop();
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const at = ctx.currentTime + 0.05;
    this.#startedAt = at;
    this.#startVideo = from;
    this.running = true;

    if (this.#bed) {
      const src = ctx.createBufferSource();
      src.buffer = this.#bed.buffer;
      // Dip the music under the voice-over, the same way the export mix does.
      const bedGain = ctx.createGain();
      bedGain.gain.setValueAtTime(1, at);
      for (const [a, b] of this.#duck.ranges) {
        if (b < from) continue;
        const ta = at + Math.max(0, a - from);
        const tb = at + (b - from);
        const low = this.#duck.level;
        bedGain.gain.setValueAtTime(a < from ? low : 1, ta);
        bedGain.gain.linearRampToValueAtTime(low, Math.max(ta, at + (a + 0.2 - from)));
        bedGain.gain.setValueAtTime(low, Math.max(ta, tb - 0.3));
        bedGain.gain.linearRampToValueAtTime(1, tb);
      }
      src.connect(bedGain).connect(ctx.destination);
      const offset = this.#bed.offset + from;
      if (offset < this.#bed.buffer.duration) {
        src.start(at, offset);
        if (Number.isFinite(until)) src.stop(at + (until - from));
        this.#sources.push(src);
      }
    }
    for (const cue of this.#cues) {
      if (cue.t < from - 0.001 || cue.t > until) continue;
      this.#play(cue.sound, at + (cue.t - from), cue.gain * this.#gain, cue.pan, cue.rate);
    }
    for (const line of this.#voice) {
      const buffer = this.#voiceBuffers.get(line.url);
      if (!buffer || line.start > until || line.start + buffer.duration < from) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const amp = ctx.createGain();
      amp.gain.value = this.#voiceGain;
      src.connect(amp).connect(ctx.destination);
      // Starting mid-line plays the rest of it.
      src.start(at + Math.max(0, line.start - from), Math.max(0, from - line.start));
      if (Number.isFinite(until)) src.stop(at + (until - from));
      this.#sources.push(src);
    }
  }

  /** Plays one voice line on its own. */
  previewVoice(url: string) {
    const buffer = this.#voiceBuffers.get(url);
    if (!buffer) return false;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    src.start();
    this.#sources.push(src);
    return true;
  }

  #play(id: string, when: number, gain: number, pan = 0, rate = 1) {
    const sample = this.#samples.get(id);
    if (!sample) return;
    const ctx = this.ctx;
    const anchor = ((this.#anchors[id] ?? 'onset') === 'peak' ? sample.peak : sample.onset) / rate;
    let start = when - anchor;
    let offset = 0;
    if (start < ctx.currentTime) {
      offset = (ctx.currentTime - start) * rate;
      start = ctx.currentTime;
      if (offset >= sample.buffer.duration) return;
    }
    const src = ctx.createBufferSource();
    src.buffer = sample.buffer;
    src.playbackRate.value = rate;
    const amp = ctx.createGain();
    amp.gain.value = gain * sample.norm;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(amp).connect(panner).connect(ctx.destination);
    src.start(start, offset);
    this.#sources.push(src);
  }

  stop() {
    for (const s of this.#sources) {
      try {
        s.stop();
      } catch {}
    }
    this.#sources = [];
    this.running = false;
  }

  /** Current video time while running. */
  now() {
    return this.#startVideo + Math.max(0, this.ctx.currentTime - this.#startedAt);
  }

  /** Plays one sound right away, for auditioning. */
  preview(id: string, gain = 1) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.#play(id, this.ctx.currentTime + 0.02 + (this.#samples.get(id)?.onset ?? 0), gain);
  }

  hasSample(id: string) {
    return this.#samples.has(id);
  }
}

/** Onset, loudest moment and a gain that brings the peak to 0.9; the same as runtime/synth.js. */
function measure(buffer: AudioBuffer) {
  const data = buffer.getChannelData(0);
  const win = Math.max(1, Math.round(buffer.sampleRate * 0.01));
  let peakAt = 0;
  let peakRms = 0;
  let peakAbs = 0;
  const env: number[] = [];
  for (let i = 0; i < data.length; i += win) {
    let sum = 0;
    for (let j = i; j < Math.min(data.length, i + win); j++) {
      sum += data[j] * data[j];
      peakAbs = Math.max(peakAbs, Math.abs(data[j]));
    }
    const rms = Math.sqrt(sum / win);
    env.push(rms);
    if (rms > peakRms) {
      peakRms = rms;
      peakAt = i;
    }
  }
  const onsetIndex = env.findIndex((v) => v > peakRms * 0.1);
  return { peak: peakAt / buffer.sampleRate, onset: (Math.max(0, onsetIndex) * win) / buffer.sampleRate, norm: peakAbs > 0 ? 0.9 / peakAbs : 1 };
}
