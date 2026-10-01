import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  chordTones,
  compileScore,
  composeScore,
  cutAlignment,
  fitTempo,
  MOODS,
  noteToMidi,
  type Mood,
  type Score,
} from '../shared/score.ts';

const base: Score = { version: 1, bpm: 120, key: 'C', scale: 'major', chords: ['I'], tracks: [] };

describe('music theory', () => {
  test('note names', () => {
    assert.equal(noteToMidi('C4'), 60);
    assert.equal(noteToMidi('A4'), 69);
    assert.equal(noteToMidi('F#3'), 54);
    assert.equal(noteToMidi('Bb2'), 46);
    assert.throws(() => noteToMidi('H2'), /Unknown note/);
  });

  test('diatonic chords from roman numerals', () => {
    assert.deepEqual(chordTones('I', 'major'), [0, 4, 7]);
    assert.deepEqual(chordTones('vi', 'major'), [9, 12, 16]);
    assert.deepEqual(chordTones('V7', 'major'), [7, 11, 14, 17]);
    assert.deepEqual(chordTones('i', 'minor'), [0, 3, 7]);
    assert.deepEqual(chordTones('bVII', 'major'), [10, 14, 17]);
    assert.deepEqual(chordTones('IVsus2', 'major'), [5, 7, 12]);
    assert.throws(() => chordTones('X', 'major'), /Unknown chord/);
  });
});

describe('compileScore', () => {
  test('a drum step pattern fires on its steps for the given bars', () => {
    const { events } = compileScore(
      { ...base, tracks: [{ instrument: 'kick', pattern: 'x...x...x...x...', bars: [1, 2] }] },
      { duration: 10 },
    );
    // 120 BPM: a beat is 0.5s, bar 1 starts at 2s.
    assert.deepEqual(events.map((e) => e.t), [2, 2.5, 3, 3.5]);
  });

  test('a held chord voices every tone for the chord length', () => {
    const { events } = compileScore({ ...base, chords: ['I', 'IV'], tracks: [{ instrument: 'pad', pattern: 'chord', bars: [0, 2] }] }, { duration: 10 });
    assert.deepEqual(events.map((e) => e.midi), [48, 52, 55, 53, 57, 60]);
    assert.ok(events.every((e) => Math.abs(e.d - 2) < 1e-9));
  });

  test('melodic step strings pick chord tones and holds extend notes', () => {
    const { events } = compileScore({ ...base, tracks: [{ instrument: 'bell', pattern: '1-3.', step: 4, bars: [0, 1] }] }, { duration: 10 });
    assert.deepEqual(events.map((e) => [e.t, e.d, e.midi]), [[0, 0.95, 72], [1, 0.475, 79]]);
  });

  test('typing expands into keystrokes, and unknown things become warnings', () => {
    const out = compileScore(
      { ...base, tracks: [{ instrument: 'banjo' as any, pattern: 'chord' }], sfx: [{ t: 1, type: 'boing' as any }] },
      { duration: 5, sceneSfx: [{ t: 2, type: 'typing', d: 1, chars: 10 }] },
    );
    assert.equal(out.events.filter((e) => e.type === 'tick').length, 10);
    assert.equal(out.warnings.length, 2);
  });

  test('events never start after the video ends', () => {
    const { events } = compileScore({ ...base, tracks: [{ instrument: 'hat', pattern: 'xxxx' }] }, { duration: 3 });
    assert.ok(events.length > 0 && events.every((e) => e.t < 3));
  });

  test('beat grid', () => {
    const { beats, downbeats } = compileScore(base, { duration: 2 });
    assert.deepEqual(beats, [0, 0.5, 1, 1.5, 2]);
    assert.deepEqual(downbeats, [0, 2]);
  });
});

describe('tempo fitting and composing', () => {
  test('finds a tempo that puts cuts on beats', () => {
    // Cuts every 2.5s fit 96 BPM exactly (4 beats of 0.625s).
    const bpm = fitTempo([2.5, 5, 7.5], 90, 100, 95);
    assert.ok(cutAlignment([2.5, 5, 7.5], bpm).every((c) => Math.abs(c.ms) <= 10), `got ${bpm}`);
  });

  test('every mood composes a score that compiles without warnings', () => {
    for (const mood of Object.keys(MOODS) as Mood[]) {
      const score = composeScore({ cuts: [3.2, 7.6, 12.2, 16, 19.4], duration: 22.8, mood });
      const out = compileScore(score, { duration: 22.8 });
      assert.deepEqual(out.warnings, [], mood);
      assert.ok(out.events.length > 20, `${mood} has music`);
      assert.ok(score.bpm >= MOODS[mood].bpm[0] && score.bpm <= MOODS[mood].bpm[1]);
      assert.ok(score.sfx!.some((s) => s.t === 19.4), `${mood} marks the last cut`);
    }
  });
});
