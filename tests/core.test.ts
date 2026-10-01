import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';

// paths.ts reads STORY_HOME at import time, so point it at a scratch directory first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-test-'));
process.env.STORY_HOME = home;
const projects = await import('../server/projects.ts');
const { turnContext } = await import('../server/prompt.ts');
const { sceneFile, assertScope } = await import('../server/paths.ts');

describe('parseSceneMeta', () => {
  test('reads duration, poster and tags', () => {
    const meta = projects.parseSceneMeta(`
      <meta name="story:duration" content="3.32">
      <meta name="story:poster" content="2.1">
      <meta name="story:tags" content="loops, hero">`);
    assert.deepEqual(meta, { duration: 3.32, poster: 2.1, tags: ['loops', 'hero'] });
  });

  test('falls back to 3s and a poster at 60%', () => {
    assert.deepEqual(projects.parseSceneMeta('<html></html>'), { duration: 3, poster: 1.8, tags: [] });
  });

  test('clamps the poster to the duration', () => {
    const meta = projects.parseSceneMeta('<meta name="story:duration" content="2"><meta name="story:poster" content="9">');
    assert.equal(meta.poster, 2);
  });
});

describe('projects and versions', () => {
  let slug: string;

  before(async () => {
    slug = await projects.createProject({ name: 'Test video', codebase: home });
  });

  test('a new project has one scene with a baseline version', async () => {
    const project = await projects.getProject(slug);
    assert.equal(project.scenes.length, 1);
    assert.equal(project.scenes[0].versions, 1);
    assert.equal(project.codebase, home);
  });

  test('scene ids are unique and inserted after the given scene', async () => {
    const first = (await projects.getProject(slug)).scenes[0].id;
    const a = await projects.createScene(slug, { title: 'Intro' });
    const b = await projects.createScene(slug, { title: 'Intro', after: first });
    assert.equal(a, 'intro');
    assert.equal(b, 'intro-2');
    const order = (await projects.getProject(slug)).scenes.map((s) => s.id);
    assert.deepEqual(order, [first, 'intro-2', 'intro']);
  });

  test('undo walks back through versions and restores never duplicate', async () => {
    const id = 'intro';
    const file = sceneFile(slug, id);
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, original.replace('content="3"', 'content="4"'));
    await projects.snapshot(slug, id, 'Edit 1');
    await fs.writeFile(file, original.replace('content="3"', 'content="5"'));
    await projects.snapshot(slug, id, 'Edit 2');
    assert.equal((await projects.readVersions(slug, id)).length, 3);

    assert.equal(await projects.undo(slug, id), true);
    assert.match(await fs.readFile(file, 'utf8'), /content="4"/);
    assert.equal(await projects.undo(slug, id), true);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.equal(await projects.undo(slug, id), false, 'nothing before the first version');

    await projects.snapshot(slug, id, 'Watcher after restore');
    assert.equal((await projects.readVersions(slug, id)).length, 3, 'restored content is not stored twice');
  });

  test('an unsaved edit is snapshotted before undoing it', async () => {
    const id = 'intro-2';
    const file = sceneFile(slug, id);
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, original + '<!-- unsaved -->');
    assert.equal(await projects.undo(slug, id), true);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.equal((await projects.readVersions(slug, id)).length, 2);
  });

  test('deleting a scene moves the file to trash', async () => {
    await projects.deleteScene(slug, 'intro');
    const project = await projects.getProject(slug);
    assert.ok(!project.scenes.some((s) => s.id === 'intro'));
    const trash = await fs.readdir(path.join(home, slug, '.story', 'trash'));
    assert.equal(trash.length, 1);
  });

  test('rejects ids that could escape the project', async () => {
    await assert.rejects(projects.getProject('../etc'), /Invalid id/);
  });

  test('accepts the project-wide chat scope but not other underscore ids', () => {
    assert.equal(assertScope('_project'), '_project');
    assert.equal(assertScope('intro'), 'intro');
    assert.throws(() => assertScope('_other'), /Invalid id/);
  });
});

describe('turnContext', () => {
  test('gives scene-relative beats and neighbours', async () => {
    const slug = await projects.createProject({ name: 'Beats', codebase: home });
    await projects.createScene(slug, { title: 'Second' });
    const project = await projects.getProject(slug);
    project.audio = {
      file: 'assets/audio/x.mp3',
      name: 'x.mp3',
      duration: 30,
      offset: 1,
      bpm: 120,
      beats: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
      downbeats: [1, 3, 5],
    };
    const second = project.scenes[1];
    const context = turnContext(project, second.id, { playhead: 1.25 });
    // Scene 1 is 3s long and the music starts 1s in, so scene 2 starts at track time 4s.
    assert.match(context, /scene 2 of 2, starts at 3s/);
    assert.match(context, /playhead is at 1\.25s/);
    assert.match(context, /Previous scene: "Beats"/);
    assert.match(context, /Beats inside this scene \(seconds from scene start\): 0, 0\.5, 1\b/);
    assert.match(context, /Downbeats: 1\b/);
  });
});
