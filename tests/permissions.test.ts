import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codebaseDenyRules } from '../server/agent.ts';

test('the codebase is read-only, but a project inside it stays writable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-perm-'));
  for (const dir of ['src', 'projects/demo/scenes', 'projects/other']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  const rules = codebaseDenyRules(root, path.join(root, 'projects/demo'));
  assert.ok(rules.includes(`/${root}/src/**`));
  assert.ok(rules.includes(`/${root}/package.json`));
  assert.ok(rules.includes(`/${root}/projects/other/**`));
  assert.ok(!rules.some((r) => r.includes('/projects/demo')), 'the project itself is never denied');
  assert.ok(!rules.includes(`/${root}/**`));
});

test('a codebase elsewhere is denied as a whole', () => {
  assert.deepEqual(codebaseDenyRules('/code/app', '/home/me/story/projects/app'), ['//code/app/**']);
});
