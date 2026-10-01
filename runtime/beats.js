/**
 * Beat and downbeat detection, in the browser with Web Audio. Used by the editor for uploaded
 * music and by the server (in headless Chromium) for generated takes.
 *
 * 1. Onset envelope: spectral flux of a log-magnitude STFT (1024-point frames, 256-sample hop),
 *    with the local mean removed. A second envelope from the lowest bins finds kick drums.
 * 2. Tempo: autocorrelation of the envelope over 60–200 BPM, weighted towards ~120 BPM,
 *    refined to a fractional lag.
 * 3. Beats: dynamic programming (Ellis 2007), which balances onset strength against keeping a
 *    steady period, then backtracks the best path.
 * 4. Downbeats: the one-in-four phase with the most low-frequency onset energy.
 */

const FRAME = 1024;
const HOP = 256;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function onsetEnvelopes(samples, sampleRate) {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP));
  const window = new Float32Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const bins = FRAME / 2;
  const lowBins = Math.max(2, Math.round((150 * FRAME) / sampleRate));
  let prev = new Float32Array(bins);
  const full = new Float32Array(frames);
  const low = new Float32Array(frames);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(bins);
    let flux = 0;
    let lowFlux = 0;
    for (let k = 1; k < bins; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBins) lowFlux += d;
      }
    }
    full[f] = flux;
    low[f] = lowFlux;
    prev = mag;
  }
  return { full: detrend(full, sampleRate), low: detrend(low, sampleRate) };
}

/** Removes the local mean (~0.4 s) and half-wave rectifies, then scales to unit std. */
function detrend(env, sampleRate) {
  const half = Math.max(1, Math.round((0.2 * sampleRate) / HOP));
  const out = new Float32Array(env.length);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < env.length; i++) {
    while (hi < Math.min(env.length - 1, i + half)) sum += env[++hi];
    while (lo < i - half) sum -= env[lo++];
    out[i] = Math.max(0, env[i] - sum / (hi - lo + 1));
  }
  let sq = 0;
  for (const v of out) sq += v * v;
  const std = Math.sqrt(sq / Math.max(1, out.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= std;
  return out;
}

function tempo(env, rate) {
  const minLag = Math.floor((60 / 200) * rate);
  const maxLag = Math.ceil((60 / 60) * rate);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag < ac.length; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (env.length - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
    const score = ac[lag] * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic interpolation for a fractional period.
  const a = ac[best - 1] || 0;
  const b = ac[best];
  const c = ac[best + 1] || 0;
  const denom = a - 2 * b + c;
  return denom < 0 ? best + (0.5 * (a - c)) / denom : best;
}

function track(env, period, tightness = 100) {
  const n = env.length;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let bestPrev = -1;
    let bestVal = 0;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - tightness * Math.pow(Math.log((t - p) / period), 2);
      if (bestPrev < 0 || v > bestVal) {
        bestVal = v;
        bestPrev = p;
      }
    }
    score[t] = env[t] + (bestPrev >= 0 ? Math.max(0, bestVal) : 0);
    back[t] = bestVal > 0 ? bestPrev : -1;
  }
  // Start from the best-scoring frame within the last period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t;
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  return beats.reverse();
}

export async function analyzeBeats(data) {
  const decoder = new OfflineAudioContext(1, 44100, 44100);
  const buffer = await decoder.decodeAudioData(data);
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels;
  }
  const rate = buffer.sampleRate / HOP;
  const { full, low } = onsetEnvelopes(mono, buffer.sampleRate);
  const env = full.map((v, i) => v + 0.5 * low[i]);
  const period = tempo(env, rate);
  const frames = track(env, period);
  // Frame f covers samples from f*HOP; its centre is FRAME/2 later.
  const toTime = (f) => (f * HOP + FRAME / 2) / buffer.sampleRate;
  const beats = frames.map((f) => Number(toTime(f).toFixed(3)));

  // Tempo from a least-squares fit of beat times, which is steadier than any single interval.
  let bpm = (60 * rate) / period;
  if (beats.length >= 4) {
    const n = beats.length;
    const mx = (n - 1) / 2;
    const my = beats.reduce((s, b) => s + b, 0) / n;
    let num = 0;
    let den = 0;
    beats.forEach((b, i) => {
      num += (i - mx) * (b - my);
      den += (i - mx) * (i - mx);
    });
    if (num > 0) bpm = 60 / (num / den);
  }

  let bestBar = 0;
  let bestBarScore = -Infinity;
  for (let bar = 0; bar < 4; bar++) {
    let sum = 0;
    for (let i = bar; i < frames.length; i += 4) sum += low[frames[i]] || 0;
    if (sum > bestBarScore) {
      bestBarScore = sum;
      bestBar = bar;
    }
  }
  const downbeats = beats.filter((_, i) => i % 4 === bestBar);
  return { duration: buffer.duration, bpm: Number(bpm.toFixed(1)), beats, downbeats };
}
