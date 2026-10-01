import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { duckRanges, emptyVoiceover, lineHash, resolveLines, toSrt, wordBudget, wordsFromAlignment, type VoiceoverFile } from '../shared/voice.ts';

const scenes = [
  { id: 'a', start: 0, duration: 4 },
  { id: 'b', start: 4, duration: 3 },
];

function vo(lines: VoiceoverFile['lines']): VoiceoverFile {
  return { ...emptyVoiceover(), voice: { id: 'v', name: 'V' }, lines };
}

describe('voice-over', () => {
  test('lines are placed in video time and checked against the room they have', () => {
    const file = vo([
      { id: '1', scene: 'a', t: 1, text: 'one two three four five six seven eight nine ten', duration: 3.6, file: 'x.mp3' },
      { id: '2', scene: 'b', t: 0.4, text: 'short', duration: 0.5, file: 'y.mp3' },
    ]);
    file.lines.forEach((l) => (l.hash = lineHash(l, file)));
    const [first, second] = resolveLines(file, scenes);
    assert.equal(first.start, 1);
    assert.ok(Math.abs(first.room - 3.4) < 1e-9);
    assert.match(first.issues[0], /Runs 0\.2s into the next line/);
    assert.equal(second.start, 4.4);
    assert.deepEqual(second.issues, []);
  });

  test('unrecorded lines are estimated from the word count; edits make recordings stale', () => {
    const file = vo([{ id: '1', scene: 'b', t: 1, text: 'one two three four five six seven', file: 'x.mp3', duration: 2 }]);
    file.lines[0].hash = lineHash(file.lines[0], file);
    assert.equal(resolveLines(file, scenes)[0].stale, false);
    file.lines[0].text += ' eight';
    assert.equal(resolveLines(file, scenes)[0].stale, true);
    const estimated = resolveLines({ ...file, lines: [{ id: '2', scene: 'b', t: 1, text: 'one two three four five six seven eight nine' }] }, scenes)[0];
    assert.equal(estimated.estimated, true);
    assert.match(estimated.issues[0], /past the end of the video/);
  });

  test('changing the voice or settings also makes recordings stale', () => {
    const file = vo([{ id: '1', scene: 'a', t: 0, text: 'hello' }]);
    const before = lineHash(file.lines[0], file);
    assert.notEqual(before, lineHash(file.lines[0], { ...file, voice: { id: 'other', name: 'O' } }));
    assert.notEqual(before, lineHash(file.lines[0], { ...file, settings: { ...file.settings, speed: 1.1 } }));
  });

  test('word budgets follow a calm narration pace', () => {
    assert.equal(wordBudget(4.3), 10);
    assert.equal(wordBudget(0.2), 0);
  });

  test('words come from per-character timings', () => {
    const chars = [...'Hi there.'];
    const words = wordsFromAlignment({
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.1),
      character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.1),
    });
    assert.deepEqual(words, [{ w: 'Hi', s: 0, e: 0.2 }, { w: 'there.', s: 0.3, e: 0.9 }]);
  });

  test('captions break at sentences and use spoken word times', () => {
    const line = {
      ...resolveLines(vo([{ id: '1', scene: 'b', t: 0.5, text: 'Describe a moment. Claude builds it.', duration: 2 }]), scenes)[0],
      words: [
        { w: 'Describe', s: 0, e: 0.4 }, { w: 'a', s: 0.4, e: 0.5 }, { w: 'moment.', s: 0.5, e: 0.9 },
        { w: 'Claude', s: 1.1, e: 1.4 }, { w: 'builds', s: 1.4, e: 1.7 }, { w: 'it.', s: 1.7, e: 1.9 },
      ],
    };
    assert.equal(toSrt([line]), '1\n00:00:04,500 --> 00:00:05,400\nDescribe a moment.\n\n2\n00:00:05,600 --> 00:00:06,400\nClaude builds it.\n');
  });

  test('music ducking ranges merge when lines are close', () => {
    assert.deepEqual(duckRanges([{ start: 1, end: 2 }, { start: 2.3, end: 3 }, { start: 6, end: 7 }]), [[0.8, 3.35], [5.8, 7.35]]);
  });
});
