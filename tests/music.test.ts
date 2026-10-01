import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cutSfx, defaultPlan, elevenLabsRequest, timeSections } from '../shared/music.ts';

const scenes = [
  { id: 'title', duration: 3.5 },
  { id: 'flash', duration: 1.2 },
  { id: 'demo', duration: 4.6 },
  { id: 'detail', duration: 4.1 },
  { id: 'logo', duration: 3.4 },
];

describe('music plans', () => {
  test('the default plan gives each scene a section, merging ones under 3s', () => {
    const plan = defaultPlan(scenes, 'minimal');
    assert.deepEqual(plan.sections.map((s) => s.scenes), [['title'], ['flash', 'demo'], ['detail'], ['logo']]);
    assert.equal(plan.sections[0].label, 'Intro');
    assert.equal(plan.sections.at(-1)!.label, 'Outro');
    assert.ok(plan.styles.includes('instrumental'));
    assert.ok(plan.avoid.includes('vocals'));
    assert.match(plan.styles.at(-1)!, /^\d+ bpm$/);
  });

  test('sections take their length from the scenes, and new scenes join the section before them', () => {
    const plan = defaultPlan(scenes, 'minimal');
    const timed = timeSections(plan, [...scenes.slice(0, 3), { id: 'new', duration: 2 }, ...scenes.slice(3)]);
    assert.deepEqual(timed[1].scenes, ['flash', 'demo', 'new']);
    assert.equal(timed[1].start, 3.5);
    assert.ok(Math.abs(timed[1].duration - 7.8) < 1e-9);
  });

  test('a section that becomes too short merges into its neighbour', () => {
    const plan = defaultPlan(scenes, 'minimal');
    const timed = timeSections(plan, scenes.map((s) => (s.id === 'detail' ? { ...s, duration: 1 } : s)));
    assert.ok(timed.every((s) => s.duration >= 3));
    assert.deepEqual(timed.at(-1)!.scenes, ['detail', 'logo']);
  });

  test('v2.5 request: one chunk per section, durations summing exactly to the video', () => {
    const plan = defaultPlan(scenes, 'cinematic');
    const { body, totalSeconds } = elevenLabsRequest(plan, scenes);
    const chunks = (body.composition_plan as any).chunks;
    assert.equal(body.model_id, 'music_v2_5');
    assert.equal(chunks.length, 4);
    assert.equal(chunks.reduce((s: number, c: any) => s + c.duration_ms, 0), Math.round(totalSeconds * 1000));
    assert.ok(chunks.every((c: any) => c.positive_styles.includes('instrumental') && c.negative_styles.includes('vocals')));
    assert.match(chunks[0].text, /^\[Intro\]\n/);
  });

  test('v1 request uses sections and asks for exact durations', () => {
    const plan = { ...defaultPlan(scenes, 'minimal'), model: 'music_v1' as const };
    const { body } = elevenLabsRequest(plan, scenes);
    const cp = body.composition_plan as any;
    assert.equal(body.respect_sections_durations, true);
    assert.deepEqual(cp.sections.map((s: any) => s.section_name), ['Intro', 'Build', 'Main', 'Outro']);
    assert.ok(cp.positive_global_styles.length > 0);
  });

  test('cut sound effects: a whoosh on every cut and a hit into the last scene', () => {
    const sfx = cutSfx([3.5, 4.7, 9.3, 13.4], 16.8);
    assert.equal(sfx.filter((s) => s.type === 'whoosh').length, 4);
    assert.deepEqual(sfx.filter((s) => s.type !== 'whoosh').map((s) => [s.type, s.t]), [['riser', 13.4], ['impact', 13.4]]);
  });
});
