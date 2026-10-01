import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emptySounds, resolveCues, withPresets, type SoundsFile } from '../shared/sound.ts';

const scenes = [
  { id: 'intro', start: 0, duration: 3 },
  { id: 'checklist', start: 3, duration: 3 },
];

describe('resolveCues', () => {
  test('placed cues land in video time', () => {
    const sounds: SoundsFile = { ...emptySounds(), scenes: { checklist: { cues: [{ id: 'a', t: 0.8, sound: 'tick', gain: 0.9 }] } } };
    const [cue] = resolveCues(sounds, scenes, {});
    assert.deepEqual([cue.t, cue.local, cue.scene, cue.sound, cue.gain, cue.auto], [3.8, 0.8, 'checklist', 'tick', 0.9, false]);
  });

  test('typing becomes one keystroke per character, timed to the characters appearing', () => {
    const cues = resolveCues(emptySounds(), scenes, { intro: [{ type: 'typing', t: 1, d: 1, chars: 10, source: 'helper' }] });
    assert.equal(cues.length, 10);
    assert.ok(cues.every((c) => c.sound === 'keystroke' && c.auto && c.id === cues[0].id));
    assert.ok(Math.abs(cues[0].t - 1.09) < 1e-9 && Math.abs(cues[9].t - 1.99) < 1e-9);
    assert.ok(cues.some((c) => c.rate !== 1), 'keystrokes vary so they do not sound robotic');
  });

  test('automatic cues can be muted per scene, and muted cues stay listed', () => {
    const report = { intro: [{ type: 'click', t: 2.1, source: 'helper' as const }] };
    const [cue] = resolveCues(emptySounds(), scenes, report);
    assert.equal(cue.id, 'auto:intro:click:2100');
    const sounds = { ...emptySounds(), scenes: { intro: { cues: [], muted: [cue.id] } } };
    assert.equal(resolveCues(sounds, scenes, report)[0].muted, true);
  });

  test('Story.sound names map to library sounds; unknown ones are skipped', () => {
    const cues = resolveCues(emptySounds(), scenes, {
      intro: [
        { type: 'chime', t: 1, source: 'scene' },
        { type: 'kazoo', t: 1.5, source: 'scene' },
      ],
    });
    assert.deepEqual(cues.map((c) => c.sound), ['success']);
  });

  test('whooshes on cuts only when switched on', () => {
    assert.equal(resolveCues(emptySounds(), scenes, {}).length, 0);
    const cues = resolveCues({ ...emptySounds(), whooshOnCuts: true }, scenes, {});
    assert.deepEqual(cues.map((c) => [c.sound, c.t]), [['whoosh', 3]]);
  });

  test('cues outside their scene are dropped', () => {
    const sounds: SoundsFile = { ...emptySounds(), scenes: { intro: { cues: [{ id: 'x', t: 5, sound: 'pop' }] } } };
    assert.equal(resolveCues(sounds, scenes, {}).length, 0);
  });

  test('older files get new presets without losing generated sounds', () => {
    const old = { version: 1, library: [{ id: 'tick', label: 'Tick', source: 'preset', file: 'assets/audio/sfx/tick-v3.mp3', variant: 3 }], scenes: {} } as SoundsFile;
    const file = withPresets(old);
    assert.equal(file.library.find((s) => s.id === 'tick')!.file, 'assets/audio/sfx/tick-v3.mp3');
    assert.ok(file.library.some((s) => s.id === 'keystroke'));
  });
});
