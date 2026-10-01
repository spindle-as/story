/*
 * spindle/story soundtrack synthesizer.
 *
 * Renders the flat event list produced by shared/score.ts (compileScore) into audio with an
 * OfflineAudioContext, then encodes it as a 16-bit WAV. It runs in the headless Chromium the
 * server already uses, so a score renders identically every time.
 */
(function () {
  'use strict';

  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function noiseBuffer(ctx, seconds, seed) {
    const rand = prng(seed);
    const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
    return buf;
  }

  function impulse(ctx, seconds, decay, seed) {
    const rand = prng(seed);
    const len = Math.ceil(seconds * ctx.sampleRate);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (rand() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  async function render(events, options = {}) {
    const sampleRate = options.sampleRate || 48000;
    const duration = Math.max(0.5, options.duration || 1);
    const master = options.master || {};
    const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
    const noise = noiseBuffer(ctx, 3, 7);

    const out = ctx.createGain();
    const level = master.gain ?? 0.9;
    out.gain.setValueAtTime(master.fadeIn ? 0 : level, 0);
    if (master.fadeIn) out.gain.linearRampToValueAtTime(level, master.fadeIn);
    if (master.fadeOut) {
      out.gain.setValueAtTime(level, Math.max(0, duration - master.fadeOut));
      out.gain.linearRampToValueAtTime(0, duration);
    }
    out.connect(ctx.destination);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.006;
    comp.release.value = 0.2;
    comp.connect(out);

    // Rumble and DC never help a mix; cut below 30 Hz before the compressor.
    const clean = ctx.createBiquadFilter();
    clean.type = 'highpass';
    clean.frequency.value = 30;
    clean.Q.value = 0.7;
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 5000;
    air.gain.value = 3;
    clean.connect(air);
    air.connect(comp);

    const bus = ctx.createGain();
    // Recorded sound design is already mastered: mix it untouched, like the editor's live preview.
    bus.connect(options.samplesOnly ? out : clean);
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 2.8, 3.2, 11);
    const verbIn = ctx.createGain();
    verbIn.gain.value = master.reverb ?? 0.3;
    verbIn.connect(verb);
    verb.connect(clean);

    /** Per-voice output: panned into the bus, plus a reverb send. */
    function voice(e, sendFloor = 0) {
      const input = ctx.createGain();
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, e.pan || 0));
      input.connect(pan);
      pan.connect(bus);
      const send = ctx.createGain();
      send.gain.value = Math.max(sendFloor, e.reverb ?? 0.2);
      pan.connect(send);
      send.connect(verbIn);
      return { input, pan };
    }

    function osc(type, freq, t, stop, detune = 0) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.detune.value = detune;
      o.start(t);
      o.stop(stop);
      return o;
    }

    function noiseSource(t, stop, seed) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.start(t, (seed * 0.137) % 2.5);
      src.stop(stop);
      return src;
    }

    /** Attack, decay to sustain, hold until `end`, release. Returns when the voice is silent. */
    function adsr(param, t, peak, a, d, s, end, r) {
      param.setValueAtTime(0, t);
      param.linearRampToValueAtTime(peak, t + a);
      if (s < 1) param.setTargetAtTime(peak * s, t + a, Math.max(0.001, d / 3));
      const off = Math.max(end, t + a);
      param.setTargetAtTime(0, off, Math.max(0.001, r / 3));
      return off + r * 2;
    }

    function perc(param, t, peak, decay, attack = 0.001) {
      param.setValueAtTime(0, t);
      param.linearRampToValueAtTime(peak, t + attack);
      param.setTargetAtTime(0, t + attack, decay / 3);
      return t + attack + decay * 2;
    }

    function filter(type, freq, q = 0.7) {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    }

    const instruments = {
      pad(e, out) {
        const f = hz(e.midi);
        const amp = ctx.createGain();
        const lp = filter('lowpass', 1500, 0.3);
        const end = adsr(amp.gain, e.t, e.v * 0.12, 0.7, 1, 0.85, e.t + e.d, 1.4);
        lp.frequency.setValueAtTime(700, e.t);
        lp.frequency.linearRampToValueAtTime(1700, e.t + 1.2);
        for (const cents of [-9, 0, 9]) osc('sawtooth', f, e.t, end, cents).connect(lp);
        const body = ctx.createGain();
        body.gain.value = 0.3;
        osc('sine', f / 2, e.t, end).connect(body);
        body.connect(amp);
        lp.connect(amp);
        amp.connect(out.input);
      },
      strings(e, out) {
        const f = hz(e.midi);
        const amp = ctx.createGain();
        const lp = filter('lowpass', 2200, 0.4);
        const end = adsr(amp.gain, e.t, e.v * 0.12, 1.0, 1, 0.9, e.t + e.d, 1.6);
        const lfo = osc('sine', 5, e.t, end);
        const depth = ctx.createGain();
        depth.gain.setValueAtTime(0, e.t);
        depth.gain.linearRampToValueAtTime(5, e.t + 0.8);
        lfo.connect(depth);
        for (const cents of [-6, 6]) {
          const o = osc('sawtooth', f, e.t, end, cents);
          depth.connect(o.detune);
          o.connect(lp);
        }
        lp.connect(amp);
        amp.connect(out.input);
      },
      keys(e, out) {
        const f = hz(e.midi);
        const amp = ctx.createGain();
        const end = adsr(amp.gain, e.t, e.v * 0.32, 0.004, 1.4, 0.25, e.t + e.d, 0.5);
        const carrier = osc('sine', f, e.t, end);
        const mod = osc('sine', f, e.t, end);
        const index = ctx.createGain();
        // Index stays below the carrier frequency; deeper FM swings it negative and adds DC.
        index.gain.setValueAtTime(f * 0.8, e.t);
        index.gain.setTargetAtTime(f * 0.12, e.t, 0.2);
        mod.connect(index);
        index.connect(carrier.frequency);
        carrier.connect(amp);
        const tine = ctx.createGain();
        perc(tine.gain, e.t, e.v * 0.05, 0.25);
        osc('sine', f * 4, e.t, e.t + 0.6).connect(tine);
        tine.connect(out.input);
        amp.connect(out.input);
      },
      pluck(e, out) {
        const f = hz(e.midi);
        const amp = ctx.createGain();
        const lp = filter('lowpass', 5000, 2);
        lp.frequency.setValueAtTime(5200, e.t);
        lp.frequency.setTargetAtTime(380, e.t, 0.07);
        const end = perc(amp.gain, e.t, e.v * 0.22, Math.min(0.5, Math.max(0.18, e.d * 1.5)), 0.002);
        osc('sawtooth', f, e.t, end).connect(lp);
        osc('square', f, e.t, end, -10).connect(lp);
        lp.connect(amp);
        amp.connect(out.input);
      },
      bell(e, out) {
        const f = hz(e.midi);
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.28, 2.2, 0.002);
        const carrier = osc('sine', f, e.t, end);
        const mod = osc('sine', f * 3.5, e.t, end);
        const index = ctx.createGain();
        index.gain.setValueAtTime(f * 2, e.t);
        index.gain.setTargetAtTime(f * 0.1, e.t, 0.5);
        mod.connect(index);
        index.connect(carrier.frequency);
        carrier.connect(amp);
        amp.connect(out.input);
      },
      lead(e, out) {
        const f = hz(e.midi);
        const amp = ctx.createGain();
        const lp = filter('lowpass', 2400, 0.8);
        const end = adsr(amp.gain, e.t, e.v * 0.1, 0.02, 0.3, 0.7, e.t + e.d, 0.2);
        const o = osc('square', f, e.t, end);
        const lfo = osc('sine', 5.5, e.t, end);
        const depth = ctx.createGain();
        depth.gain.setValueAtTime(0, e.t);
        depth.gain.linearRampToValueAtTime(12, e.t + 0.4);
        lfo.connect(depth);
        depth.connect(o.detune);
        o.connect(lp);
        lp.connect(amp);
        amp.connect(out.input);
      },
      bass(e, out) {
        const f = hz(e.midi);
        const amp = ctx.createGain();
        const lp = filter('lowpass', 600, 1.2);
        lp.frequency.setValueAtTime(1500, e.t);
        lp.frequency.setTargetAtTime(450, e.t, 0.06);
        const end = adsr(amp.gain, e.t, e.v * 0.3, 0.005, 0.2, 0.7, e.t + e.d, 0.08);
        osc('sawtooth', f, e.t, end).connect(lp);
        osc('sine', f, e.t, end).connect(amp);
        lp.connect(amp);
        amp.connect(out.input);
      },
      sub(e, out) {
        const f = hz(e.midi);
        const amp = ctx.createGain();
        const end = adsr(amp.gain, e.t, e.v * 0.45, 0.03, 0.4, 0.9, e.t + e.d, 0.35);
        osc('sine', f, e.t, end).connect(amp);
        const harm = ctx.createGain();
        harm.gain.value = 0.12;
        osc('triangle', f * 2, e.t, end).connect(harm);
        harm.connect(amp);
        amp.connect(out.input);
      },
      kick(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 1.0, 0.45);
        const o = osc('sine', 160, e.t, end);
        o.frequency.exponentialRampToValueAtTime(45, e.t + 0.12);
        o.connect(amp);
        const click = ctx.createGain();
        perc(click.gain, e.t, e.v * 0.25, 0.008);
        const hp = filter('highpass', 3000);
        noiseSource(e.t, e.t + 0.05, e.seed).connect(hp);
        hp.connect(click);
        click.connect(out.input);
        amp.connect(out.input);
      },
      snare(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.5, 0.18);
        const bp = filter('bandpass', 1800, 0.8);
        noiseSource(e.t, end, e.seed).connect(bp);
        bp.connect(amp);
        const body = ctx.createGain();
        perc(body.gain, e.t, e.v * 0.35, 0.1);
        const o = osc('triangle', 190, e.t, e.t + 0.25);
        o.frequency.exponentialRampToValueAtTime(150, e.t + 0.1);
        o.connect(body);
        body.connect(out.input);
        amp.connect(out.input);
      },
      clap(e, out) {
        const amp = ctx.createGain();
        const g = amp.gain;
        g.setValueAtTime(0, e.t);
        for (const dt of [0, 0.011, 0.022]) {
          g.setValueAtTime(e.v * 0.55, e.t + dt);
          g.setTargetAtTime(e.v * 0.1, e.t + dt + 0.001, 0.004);
        }
        g.setValueAtTime(e.v * 0.45, e.t + 0.033);
        g.setTargetAtTime(0, e.t + 0.034, 0.05);
        const bp = filter('bandpass', 1200, 1.2);
        noiseSource(e.t, e.t + 0.4, e.seed).connect(bp);
        bp.connect(amp);
        amp.connect(out.input);
      },
      rim(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.4, 0.04);
        const bp = filter('bandpass', 1700, 3);
        osc('triangle', 820, e.t, end).connect(bp);
        osc('sine', 1700, e.t, end).connect(bp);
        bp.connect(amp);
        amp.connect(out.input);
      },
      hat(e, out, open = false) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.28, open ? 0.3 : 0.045);
        const hp = filter('highpass', 7500, 0.8);
        noiseSource(e.t, end, e.seed).connect(hp);
        hp.connect(amp);
        amp.connect(out.input);
      },
      openhat(e, out) {
        instruments.hat(e, out, true);
      },
      shaker(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.2, 0.07, 0.012);
        const bp = filter('bandpass', 6500, 1.2);
        noiseSource(e.t, end, e.seed).connect(bp);
        bp.connect(amp);
        amp.connect(out.input);
      },
      tom(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.9, 0.7);
        const o = osc('sine', 110, e.t, end);
        o.frequency.exponentialRampToValueAtTime(62, e.t + 0.25);
        o.connect(amp);
        const thud = ctx.createGain();
        perc(thud.gain, e.t, e.v * 0.3, 0.1);
        const lp = filter('lowpass', 420);
        noiseSource(e.t, e.t + 0.3, e.seed).connect(lp);
        lp.connect(thud);
        thud.connect(out.input);
        amp.connect(out.input);
      },
    };

    const sfx = {
      whoosh(e, out, length = 0.7, high = 2600) {
        const d = e.d || length;
        const start = Math.max(0, e.t - d * 0.6);
        const end = e.t + d * 0.4;
        const bp = filter('bandpass', 250, 1.4);
        bp.frequency.setValueAtTime(250, start);
        bp.frequency.exponentialRampToValueAtTime(high, e.t);
        bp.frequency.exponentialRampToValueAtTime(700, end);
        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, start);
        amp.gain.exponentialRampToValueAtTime(e.v * 0.9, e.t);
        amp.gain.exponentialRampToValueAtTime(0.0001, end);
        out.pan.pan.setValueAtTime(-0.6, start);
        out.pan.pan.linearRampToValueAtTime(0.6, end);
        noiseSource(start, end + 0.05, e.seed).connect(bp);
        bp.connect(amp);
        amp.connect(out.input);
      },
      swoosh(e, out) {
        sfx.whoosh(e, out, 0.35, 4200);
      },
      riser(e, out) {
        const d = e.d || 1.5;
        const start = Math.max(0, e.t - d);
        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, start);
        amp.gain.exponentialRampToValueAtTime(e.v * 0.6, e.t);
        amp.gain.linearRampToValueAtTime(0, e.t + 0.04);
        const hp = filter('highpass', 400, 1);
        hp.frequency.setValueAtTime(400, start);
        hp.frequency.exponentialRampToValueAtTime(6000, e.t);
        noiseSource(start, e.t + 0.05, e.seed).connect(hp);
        hp.connect(amp);
        const tone = ctx.createGain();
        tone.gain.value = 0.35;
        const lp = filter('lowpass', 2500);
        const o = osc('sawtooth', 180, start, e.t + 0.05);
        o.frequency.exponentialRampToValueAtTime(1400, e.t);
        o.connect(lp);
        lp.connect(tone);
        tone.connect(amp);
        amp.connect(out.input);
      },
      impact(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 1.1, 1.4);
        const o = osc('sine', 72, e.t, end);
        o.frequency.exponentialRampToValueAtTime(32, e.t + 0.6);
        o.connect(amp);
        const hit = ctx.createGain();
        perc(hit.gain, e.t, e.v * 0.6, 0.3);
        const lp = filter('lowpass', 1100);
        noiseSource(e.t, e.t + 0.8, e.seed).connect(lp);
        lp.connect(hit);
        hit.connect(out.input);
        amp.connect(out.input);
      },
      drop(e, out) {
        const d = e.d || 0.8;
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.7, d);
        const o = osc('sine', 420, e.t, end);
        o.frequency.exponentialRampToValueAtTime(40, e.t + d);
        o.connect(amp);
        amp.connect(out.input);
      },
      click(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.5, 0.014);
        osc('sine', 2400, e.t, end).connect(amp);
        const hp = filter('highpass', 4000);
        const n = ctx.createGain();
        perc(n.gain, e.t, e.v * 0.4, 0.008);
        noiseSource(e.t, e.t + 0.03, e.seed).connect(hp);
        hp.connect(n);
        n.connect(out.input);
        amp.connect(out.input);
      },
      tick(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.5, 0.016);
        const bp = filter('bandpass', 3200, 2);
        noiseSource(e.t, end, e.seed).connect(bp);
        bp.connect(amp);
        const body = ctx.createGain();
        perc(body.gain, e.t, e.v * 0.15, 0.01);
        osc('sine', 1100, e.t, e.t + 0.04).connect(body);
        body.connect(out.input);
        amp.connect(out.input);
      },
      pop(e, out) {
        const amp = ctx.createGain();
        const end = perc(amp.gain, e.t, e.v * 0.45, 0.09);
        const o = osc('sine', 500, e.t, end);
        o.frequency.exponentialRampToValueAtTime(1100, e.t + 0.05);
        o.connect(amp);
        amp.connect(out.input);
      },
      swell(e, out) {
        const d = e.d || 1.2;
        const start = Math.max(0, e.t - d);
        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, start);
        amp.gain.exponentialRampToValueAtTime(e.v * 0.5, e.t);
        amp.gain.linearRampToValueAtTime(0, e.t + 0.03);
        const hp = filter('highpass', 5000);
        noiseSource(start, e.t + 0.05, e.seed).connect(hp);
        hp.connect(amp);
        amp.connect(out.input);
      },
      shimmer(e, out) {
        const rand = prng(e.seed * 31 + 5);
        const notes = [84, 86, 88, 91, 93, 96];
        for (let i = 0; i < 5; i++) {
          instruments.bell({ ...e, t: e.t + i * 0.07, midi: notes[Math.floor(rand() * notes.length)], v: e.v * (0.7 - i * 0.08) }, out);
        }
      },
      chime(e, out) {
        for (const [i, midi] of [79, 83, 86, 91].entries()) instruments.bell({ ...e, t: e.t + i * 0.035, midi, v: e.v * 0.8 }, out);
      },
    };

    // A finished music track (e.g. from ElevenLabs) plays as a bed, after the compressor so its
    // mastering is left alone; only the master fades touch it.
    if (options.bed) {
      const buffer = await load(ctx, options.bed.url);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      const level = options.bed.gain ?? 1;
      gain.gain.setValueAtTime(level, 0);
      // Dip the music while the voice-over speaks.
      for (const [from, to] of (options.bed.duck && options.bed.duck.ranges) || []) {
        const low = level * options.bed.duck.level;
        gain.gain.setValueAtTime(level, Math.max(0, from));
        gain.gain.linearRampToValueAtTime(low, from + 0.2);
        gain.gain.setValueAtTime(low, Math.max(from + 0.2, to - 0.3));
        gain.gain.linearRampToValueAtTime(level, to);
      }
      src.connect(gain);
      gain.connect(out);
      src.start(0, options.bed.offset || 0);
    }

    // Recorded sound effects replace the synthesized ones where available.
    const samples = {};
    for (const [type, url] of Object.entries(options.samples || {})) {
      try {
        const buffer = await load(ctx, url);
        samples[type] = { buffer, ...measure(buffer) };
      } catch (err) {
        console.error('could not load sample', type, err);
      }
    }

    function playSample(e, out, sample) {
      const peakTypes = ['whoosh', 'swoosh', 'riser', 'swell'];
      const mode = (options.anchors && options.anchors[e.type]) || (peakTypes.includes(e.type) ? 'peak' : 'onset');
      const rate = e.rate || 1;
      const anchor = mode === 'start' ? 0 : (mode === 'peak' ? sample.peak : sample.onset) / rate;
      let start = e.t - anchor;
      let offset = 0;
      if (start < 0) {
        offset = -start;
        start = 0;
      }
      const src = ctx.createBufferSource();
      src.buffer = sample.buffer;
      src.playbackRate.value = rate;
      const amp = ctx.createGain();
      // Speech keeps its recorded level; effects are normalised so presets sit together.
      const level = e.v * (mode === 'start' ? 1 : sample.norm);
      if (e.type === 'typing') {
        // A typing bed, trimmed to the typing tween's length.
        const d = Math.max(0.2, e.d || 1);
        src.loop = sample.buffer.duration < d + sample.onset;
        offset = sample.onset;
        start = e.t;
        amp.gain.setValueAtTime(0, start);
        amp.gain.linearRampToValueAtTime(level, start + 0.03);
        amp.gain.setValueAtTime(level, start + d - 0.05);
        amp.gain.linearRampToValueAtTime(0, start + d);
        src.start(start, offset);
        src.stop(start + d + 0.05);
      } else {
        amp.gain.value = level;
        src.start(start, offset);
      }
      src.connect(amp);
      amp.connect(out.input);
    }

    for (const e of events) {
      try {
        if (e.kind === 'sfx' && samples[e.type]) {
          playSample(e, voice(e), samples[e.type]);
        } else if (e.kind === 'sfx' && options.samplesOnly) {
          // Sound design cues only play real recordings; never fall back to synthesized ones.
        } else if (e.kind === 'note') {
          const fn = instruments[e.type];
          if (fn) fn(e, voice(e));
        } else {
          const fn = sfx[e.type];
          if (fn) fn(e, voice(e, e.type === 'impact' || e.type === 'chime' ? 0.45 : 0));
        }
      } catch (err) {
        console.error('synth event failed', e, err);
      }
    }

    return ctx.startRendering();
  }

  async function load(ctx, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return ctx.decodeAudioData(await res.arrayBuffer());
  }

  /** Onset, loudest moment and a gain that brings the sample's peak to 0.9. */
  function measure(buffer) {
    const data = buffer.getChannelData(0);
    const win = Math.max(1, Math.round(buffer.sampleRate * 0.01));
    let peakAt = 0;
    let peakRms = 0;
    let peakAbs = 0;
    const env = [];
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
    return {
      peak: peakAt / buffer.sampleRate,
      onset: Math.max(0, onsetIndex) * win / buffer.sampleRate,
      norm: peakAbs > 0 ? 0.9 / peakAbs : 1,
    };
  }

  /** 16-bit stereo WAV as base64, peak-normalised to `peakDb` (default -1 dBFS). */
  function encodeWav(buffer, options = {}) {
    const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
    let peak = 0;
    let sum = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
        sum += ch[i] * ch[i];
      }
    }
    const target = Math.pow(10, (options.peakDb ?? -1) / 20);
    const gain = peak > 0 ? Math.min(target / peak, 8) : 1;
    const frames = buffer.length;
    const bytes = new Uint8Array(44 + frames * 4);
    const view = new DataView(bytes.buffer);
    const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    view.setUint32(4, 36 + frames * 4, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, frames * 4, true);
    for (let i = 0, o = 44; i < frames; i++) {
      for (const ch of channels) {
        const s = Math.max(-1, Math.min(1, ch[i] * gain));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return {
      base64: btoa(binary),
      peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      rmsDb: 10 * Math.log10(sum / (frames * 2) || 1e-12) + 20 * Math.log10(gain),
      gainDb: 20 * Math.log10(gain),
    };
  }

  window.StorySynth = { render, encodeWav };
})();
