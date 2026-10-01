import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { activeLabel, clearChat, loadChat, sendMessage, stop, stopAll } from './agent.ts';
import { emit, subscribe } from './events.ts';
import { assertId, assertScope, HOST, HttpError, internalDir, PORT, PROJECTS_DIR, projectDir, ROOT, RUNTIME_DIR, sceneFile } from './paths.ts';
import {
  bumpAssets,
  createProject,
  createScene,
  currentVersionIndex,
  deleteScene,
  duplicateScene,
  getProject,
  listProjects,
  readProjectText,
  readVersion,
  readVersions,
  reorderScenes,
  restoreVersion,
  snapshot,
  undo,
  updateProject,
  updateScene,
  writeProjectText,
} from './projects.ts';
import * as renderer from './renderer.ts';
import { generateMusic, musicStatus, proposePlan, savePlan, useTake } from './music.ts';
import { composeAndRender, ensureFreshScore, renderScore, scoreStatus, selfWrites, snapScenesToBeat } from './score.ts';
import { elevenLabsKey, setElevenLabsKey } from './settings.ts';
import {
  addCustomSound,
  ensureMix,
  generateMissing,
  generateSound,
  saveSceneSounds,
  saveSoundSettings,
  soundState,
  updateSound,
  uploadSound,
} from './sound.ts';
import { migrateProjects } from './migrate.ts';
import { generateLine, generatePending, listVoices, readVoiceover, saveVoiceover, timeline as voiceTimeline, voiceStatus } from './voice.ts';
import { resolveLines, toSrt } from '../shared/voice.ts';
import { seedExamples } from './seed.ts';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).then((out) => {
    if (out !== undefined && !res.headersSent) res.json(out);
  }, next);
};
const p = (req: Request) => assertId(String(req.params.project));
const s = (req: Request) => assertId(String(req.params.scene));

// ---------------------------------------------------------------------------
// Scene runtime

const GSAP_FILES = [
  'gsap', 'CustomEase', 'CustomBounce', 'CustomWiggle', 'DrawSVGPlugin', 'MorphSVGPlugin', 'MotionPathPlugin',
  'SplitText', 'ScrambleTextPlugin', 'TextPlugin', 'EasePack', 'Physics2DPlugin', 'PhysicsPropsPlugin',
];
const FONTS: Record<string, string> = {
  inter: '@fontsource-variable/inter',
  geist: '@fontsource-variable/geist',
  'geist-mono': '@fontsource-variable/geist-mono',
  'jetbrains-mono': '@fontsource-variable/jetbrains-mono',
  'instrument-serif': '@fontsource/instrument-serif',
};

async function runtimeBundle() {
  const parts = await Promise.all(
    GSAP_FILES.map((f) => fsp.readFile(path.join(ROOT, 'node_modules/gsap/dist', `${f}.min.js`), 'utf8')),
  );
  parts.push(await fsp.readFile(path.join(RUNTIME_DIR, 'story.js'), 'utf8'));
  return parts.map((x) => x.replace(/\/\/# sourceMappingURL=.*$/m, '')).join(';\n');
}

app.get('/runtime/story.js', h(async (_req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(await runtimeBundle());
}));
app.get('/runtime/synth.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(RUNTIME_DIR, 'synth.js'));
});
app.get('/runtime/beats.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/javascript').sendFile(path.join(RUNTIME_DIR, 'beats.js'));
});
app.get('/runtime/synth.html', (_req, res) => {
  res.type('html').send(
    '<!doctype html><meta charset="utf-8"><script src="/runtime/synth.js"></script>' +
      '<script type="module">import { analyzeBeats } from "/runtime/beats.js"; window.StoryBeats = { analyzeBeats };</script>',
  );
});
app.get('/runtime/story.css', (_req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(RUNTIME_DIR, 'story.css'));
});
app.use('/runtime/fonts/:font', (req, res, next) => {
  const pkg = FONTS[String(req.params.font)];
  if (!pkg) return next();
  express.static(path.join(ROOT, 'node_modules', pkg), { maxAge: '7d' })(req, res, next);
});

// Project files (scenes, theme, assets, renders). A scene can be served at an older version with ?version=.
app.get('/p/:project/scenes/:file', h(async (req, res) => {
  const slug = p(req);
  const file = String(req.params.file);
  const version = req.query.version ? String(req.query.version) : null;
  if (!file.endsWith('.html')) return void res.sendFile(path.join(projectDir(slug), 'scenes', path.basename(file)));
  const id = assertId(file.slice(0, -5));
  const html = version ? await readVersion(slug, id, version) : await fsp.readFile(sceneFile(slug, id), 'utf8');
  res.type('html').set('Cache-Control', 'no-store').send(html);
}));
app.use('/p/:project', (req, res, next) => {
  const slug = p(req);
  if (req.path.startsWith('/.story/chats')) return res.status(404).end();
  express.static(projectDir(slug), { dotfiles: 'allow', cacheControl: false, setHeaders: (r) => r.set('Cache-Control', 'no-cache') })(req, res, next);
});

// ---------------------------------------------------------------------------
// API

app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/events', (_req, res) => subscribe(res));

app.get('/api/projects', h(() => listProjects()));
app.post('/api/projects', h(async (req) => {
  const slug = await createProject(req.body);
  const brief = String(req.body.brief || '').trim();
  if (brief) {
    await sendMessage(slug, '_project', {
      text: `Plan and build the storyboard for this video.\n\nBrief: ${brief}\n\nStart by exploring the codebase to understand the product, its UI and its voice. Fill in art-direction.md and theme.css so they match the product's real design language. Then plan the scenes (replace the placeholder scene) and build them one by one, verifying each.`,
    });
  }
  return { slug };
}));
app.get('/api/projects/:project', h((req) => getProject(p(req))));
app.patch('/api/projects/:project', h(async (req) => {
  await updateProject(p(req), req.body);
  return getProject(p(req));
}));

app.post('/api/projects/:project/scenes', h(async (req) => {
  const id = await createScene(p(req), { title: String(req.body.title || 'New scene'), after: req.body.after });
  return { id };
}));
app.patch('/api/projects/:project/scenes/:scene', h(async (req) => {
  await updateScene(p(req), s(req), req.body);
  return { ok: true };
}));
app.delete('/api/projects/:project/scenes/:scene', h(async (req) => {
  await deleteScene(p(req), s(req));
  return { ok: true };
}));
app.post('/api/projects/:project/scenes/:scene/duplicate', h(async (req) => ({ id: await duplicateScene(p(req), s(req)) })));
app.put('/api/projects/:project/order', h(async (req) => {
  await reorderScenes(p(req), (req.body.ids as string[]).map(assertId));
  return { ok: true };
}));

app.get('/api/projects/:project/scenes/:scene/thumb', h(async (req, res) => {
  try {
    const file = await renderer.thumbnail(p(req), s(req));
    res.set('Cache-Control', 'private, max-age=31536000').sendFile(file, { dotfiles: 'allow' });
  } catch (e) {
    res.status(500).type('text').send((e as Error).message);
  }
}));

app.get('/api/projects/:project/scenes/:scene/versions', h(async (req) => ({
  versions: await readVersions(p(req), s(req)),
  current: await currentVersionIndex(p(req), s(req)),
})));
app.post('/api/projects/:project/scenes/:scene/versions/:version/restore', h(async (req) => {
  await restoreVersion(p(req), s(req), String(req.params.version));
  return { ok: true };
}));
app.post('/api/projects/:project/scenes/:scene/undo', h(async (req) => ({ ok: await undo(p(req), s(req)) })));

const TEXT_FILES = ['art-direction.md', 'theme.css'] as const;
app.get('/api/projects/:project/files/:name', h(async (req, res) => {
  const name = String(req.params.name) as (typeof TEXT_FILES)[number];
  if (!TEXT_FILES.includes(name)) throw new HttpError(404, 'Unknown file');
  res.type('text').send(await readProjectText(p(req), name));
}));
app.put('/api/projects/:project/files/:name', express.text({ limit: '2mb' }), h(async (req) => {
  const name = String(req.params.name) as (typeof TEXT_FILES)[number];
  if (!TEXT_FILES.includes(name)) throw new HttpError(404, 'Unknown file');
  await writeProjectText(p(req), name, String(req.body));
  return { ok: true };
}));

app.get('/api/projects/:project/chats/:scope', h((req) => loadChat(p(req), assertScope(String(req.params.scope)))));
app.post('/api/projects/:project/chats/:scope', h(async (req) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw new HttpError(400, 'Message is empty');
  return sendMessage(p(req), assertScope(String(req.params.scope)), {
    text,
    playhead: typeof req.body.playhead === 'number' ? req.body.playhead : undefined,
    attachments: Array.isArray(req.body.attachments) ? req.body.attachments.map(String) : undefined,
  });
}));
app.post('/api/projects/:project/chats/:scope/stop', h(async (req) => ({ ok: stop(p(req), assertScope(String(req.params.scope))) })));
app.delete('/api/projects/:project/chats/:scope', h(async (req) => {
  await clearChat(p(req), assertScope(String(req.params.scope)));
  return { ok: true };
}));

const upload = express.raw({ type: () => true, limit: '200mb' });
function safeName(name: string) {
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const base = path.basename(name, path.extname(name)).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'file';
  return { base, ext };
}
app.post('/api/projects/:project/uploads', upload, h(async (req) => {
  const { base, ext } = safeName(String(req.headers['x-filename'] || 'image.png'));
  const rel = `.story/uploads/${Date.now().toString(36)}-${base}${ext}`;
  await fsp.mkdir(path.join(internalDir(p(req)), 'uploads'), { recursive: true });
  await fsp.writeFile(path.join(projectDir(p(req)), rel), req.body as Buffer);
  return { path: rel, url: `/p/${p(req)}/${rel}` };
}));
app.post('/api/projects/:project/audio', upload, h(async (req) => {
  const { base, ext } = safeName(String(req.headers['x-filename'] || 'audio.mp3'));
  const rel = `assets/audio/${base}${ext}`;
  await fsp.mkdir(path.join(projectDir(p(req)), 'assets/audio'), { recursive: true });
  await fsp.writeFile(path.join(projectDir(p(req)), rel), req.body as Buffer);
  return { file: rel, url: `/p/${p(req)}/${rel}` };
}));

app.get('/api/projects/:project/renders', h((req) => renderer.listRenders(p(req))));
app.post('/api/projects/:project/renders', h(async (req) => {
  // A generated soundtrack follows the scenes, so bring it up to date before exporting.
  let audio: { file: string; offset: number } | null | undefined;
  if (req.body.audio) {
    // A generated score follows the scenes, so bring it up to date, then mix the sound cues over the music.
    await ensureFreshScore(p(req));
    audio = await ensureMix(p(req));
  }
  // Captions from the recorded voice-over, for whole-video exports.
  let captions: string | undefined;
  if (req.body.scope === 'all') {
    const vo = await readVoiceover(p(req));
    const lines = resolveLines(vo, voiceTimeline(await getProject(p(req)))).filter((l) => l.file && !l.stale);
    if (vo.captions && lines.length) captions = toSrt(lines);
  }
  return renderer.startRender(p(req), req.body, audio, captions);
}));

app.get('/api/projects/:project/score', h((req) => scoreStatus(p(req))));
app.post('/api/projects/:project/score/compose', h((req) => composeAndRender(p(req), req.body ?? {})));
app.post('/api/projects/:project/score/render', h((req) => renderScore(p(req))));
app.post('/api/projects/:project/score/snap', h(async (req) => {
  const changes = await snapScenesToBeat(p(req));
  if (changes.length) await ensureFreshScore(p(req));
  return { changes };
}));

// ElevenLabs music. The API key never leaves the server.
app.get('/api/settings', h(async () => {
  const { source } = await elevenLabsKey();
  return { elevenlabs: { configured: !!source, source } };
}));
app.put('/api/settings/elevenlabs', h(async (req) => {
  await setElevenLabsKey(typeof req.body.apiKey === 'string' ? req.body.apiKey : null);
  return { ok: true };
}));
app.get('/api/projects/:project/music', h((req) => musicStatus(p(req))));
app.put('/api/projects/:project/music', h(async (req) => {
  await savePlan(p(req), req.body);
  return musicStatus(p(req));
}));
app.post('/api/projects/:project/music/propose', h((req) => proposePlan(p(req), req.body?.mood)));
app.post('/api/projects/:project/music/generate', h((req) => generateMusic(p(req))));
app.post('/api/projects/:project/music/use', h((req) => useTake(p(req), req.body?.takeId)));

// Voice-over.
app.get('/api/voices', h(async (req) => listVoices(req.query.search ? String(req.query.search) : undefined)));
app.get('/api/projects/:project/voice', h((req) => voiceStatus(p(req))));
app.put('/api/projects/:project/voice', h(async (req) => {
  await saveVoiceover(p(req), req.body ?? {});
  return voiceStatus(p(req));
}));
app.post('/api/projects/:project/voice/lines/:line/generate', h(async (req) => {
  await generateLine(p(req), assertId(String(req.params.line)));
  return voiceStatus(p(req));
}));
app.post('/api/projects/:project/voice/generate', h(async (req) => {
  await generatePending(p(req));
  return voiceStatus(p(req));
}));

// Sound design: library and cues.
app.get('/api/projects/:project/sounds', h((req) => soundState(p(req))));
app.put('/api/projects/:project/sounds/scenes/:scene', h(async (req) => {
  await saveSceneSounds(p(req), s(req), req.body ?? {});
  return soundState(p(req));
}));
app.patch('/api/projects/:project/sounds', h(async (req) => {
  await saveSoundSettings(p(req), req.body ?? {});
  return soundState(p(req));
}));
app.post('/api/projects/:project/sounds/library', h(async (req) => {
  await addCustomSound(p(req), req.body ?? {});
  return soundState(p(req));
}));
app.post('/api/projects/:project/sounds/library/upload', upload, h(async (req) => {
  await uploadSound(p(req), String(req.headers['x-filename'] || 'sound.wav'), req.body as Buffer, req.headers['x-label'] ? decodeURIComponent(String(req.headers['x-label'])) : undefined);
  return soundState(p(req));
}));
app.patch('/api/projects/:project/sounds/library/:sound', h(async (req) => {
  await updateSound(p(req), assertId(String(req.params.sound)), req.body ?? {});
  return soundState(p(req));
}));
app.post('/api/projects/:project/sounds/library/:sound/generate', h(async (req) => {
  await generateSound(p(req), assertId(String(req.params.sound)));
  return soundState(p(req));
}));
app.post('/api/projects/:project/sounds/generate-missing', h(async (req) => {
  await generateMissing(p(req));
  return soundState(p(req));
}));
app.post('/api/renders/:id/cancel', h(async (req) => {
  renderer.cancelRender(String(req.params.id));
  return { ok: true };
}));

app.post('/api/reveal', h(async (req) => {
  const target = path.resolve(String(req.body.path || ''));
  if (!target.startsWith(PROJECTS_DIR)) throw new HttpError(400, 'Can only reveal project files');
  execFile('open', ['-R', target]);
  return { ok: true };
}));

app.post('/api/pick-folder', h(
  () =>
    new Promise((resolve) => {
      if (process.platform !== 'darwin') return resolve({ path: null });
      execFile(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Choose the codebase this video is about")'],
        (err, stdout) => resolve({ path: err ? null : stdout.trim().replace(/\/$/, '') }),
      );
    }),
));

app.get('/api/fs/check', h(async (req) => {
  const dir = String(req.query.path || '').replace(/^~(?=$|\/)/, process.env.HOME || '~');
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return { ok: false };
    const entries = await fsp.readdir(dir);
    const markers = ['package.json', 'composer.json', 'Gemfile', 'pyproject.toml', 'go.mod', 'Cargo.toml', '.git'];
    return { ok: true, name: path.basename(dir), markers: markers.filter((m) => entries.includes(m)) };
  } catch {
    return { ok: false };
  }
}));

// Tools for the `story` CLI the agent runs. Responses are plain text meant to be read by the model.
app.post('/api/tools/:cmd', h(async (req, res) => {
  const { project, scene, ...opts } = req.body as Record<string, any>;
  const slug = assertId(String(project));
  const need = () => {
    if (!scene) throw new HttpError(400, 'Which scene? Pass the scene id, e.g. `story sheet intro`.');
    return assertId(String(scene));
  };
  const text = (out: string) => res.type('text').send(out.trimEnd() + '\n');
  const errorsBlock = (errors: string[]) => (errors.length ? `\nErrors in the scene:\n${errors.map((e) => `  - ${e}`).join('\n')}` : '');

  switch (req.params.cmd) {
    case 'frames': {
      const out = await renderer.frames(slug, need(), opts.times?.length ? opts.times : [0], opts.scale);
      return text(out.files.join('\n') + errorsBlock(out.errors));
    }
    case 'sheet': {
      const out = await renderer.contactSheet(slug, need(), opts);
      return text(`${out.file}\nFrames at: ${out.times.map((t) => t.toFixed(2) + 's').join(', ')}${errorsBlock(out.errors)}`);
    }
    case 'check': {
      const results = await renderer.check(slug, scene ? assertId(String(scene)) : undefined);
      return text(
        results
          .map((r: any) =>
            [
              `${r.ok && !r.warnings.length ? '✓' : '✗'} ${r.scene}${r.duration ? `: ${r.duration}s (timeline ${r.timeline.toFixed(2)}s)` : ''}`,
              ...r.errors.map((e: string) => `    error: ${e}`),
              ...r.warnings.map((w: string) => `    warning: ${w}`),
            ].join('\n'),
          )
          .join('\n'),
      );
    }
    case 'seams': {
      const out = await renderer.seams(slug);
      if (!out.length) return text('Only one scene, no cuts to check.');
      return text(out.map((x) => `${x.from} → ${x.to}: ${x.diffPercent}% of pixels differ${x.diffPercent < 0.5 ? ' (invisible cut)' : ''}`).join('\n'));
    }
    case 'capture': {
      const out = await renderer.captureUrl(slug, opts as any);
      return text(`Saved ${out.file} (${out.width}×${out.height} CSS px, 2x pixels). Use it in a scene as ${out.relative}`);
    }
    case 'scenes': {
      const project = await getProject(slug);
      let t = 0;
      return text(
        project.scenes
          .map((sc, i) => {
            const line = `${i + 1}. ${sc.id} "${sc.title}" starts ${t.toFixed(2)}s, ${sc.duration}s`;
            t += sc.duration;
            return line;
          })
          .join('\n') + `\nTotal ${t.toFixed(2)}s`,
      );
    }
    case 'score': {
      const out = opts.mood || opts.compose
        ? await composeAndRender(slug, { mood: opts.mood, bpm: opts.bpm, key: opts.key, sfx: opts.sfx !== 'off' })
        : await renderScore(slug);
      return text(out.summary + (out.warnings.length ? `\nWarnings:\n${out.warnings.map((w) => `  - ${w}`).join('\n')}` : ''));
    }
    case 'cues': {
      const out = await renderer.collectCues(slug);
      return text(
        out.scenes
          .map((sc) => [
            `${sc.id}: ${sc.start.toFixed(2)}s → ${(sc.start + sc.duration).toFixed(2)}s (timeline ${sc.timeline.toFixed(2)}s)${sc.error ? ` FAILED: ${sc.error}` : ''}`,
            ...sc.cues.map((c) => `    ${(sc.start + c.t).toFixed(3)}s (scene ${c.t.toFixed(3)}s) ${c.type}${c.d ? ` ${c.d.toFixed(2)}s` : ''}${c.source === 'helper' ? ' [auto]' : ''}`),
          ].join('\n'))
          .join('\n') + `\nTotal ${out.duration.toFixed(2)}s. Cuts at: ${out.cuts.map((c) => c.toFixed(3) + 's').join(', ') || 'none'}`,
      );
    }
    case 'music': {
      if (opts.generate) {
        const out = await generateMusic(slug);
        return text(out.summary + (out.warnings.length ? `\nWarnings:\n${out.warnings.map((w) => `  - ${w}`).join('\n')}` : ''));
      }
      const st = await musicStatus(slug);
      return text(
        [
          `ElevenLabs key: ${st.key.configured ? 'configured' : 'missing (the user must add it in the Soundtrack dialog)'}`,
          `music.json: ${st.saved ? 'saved' : 'not saved yet (showing the default proposal)'}; model ${st.plan.model}; ${st.seconds.toFixed(2)}s`,
          `Styles: ${st.plan.styles.join(', ')} | avoid: ${st.plan.avoid.join(', ')}`,
          ...st.sections.map((s) => `  ${s.label}: ${s.start.toFixed(2)}–${(s.start + s.duration).toFixed(2)}s [${s.scenes.join(', ')}] ${s.text.replace(/\n/g, ' ')} | ${s.styles.join(', ')}`),
          `Takes: ${st.takes.length}${st.currentTake ? `, using ${st.currentTake}` : ''}${st.timingChanged ? ' (scene timing changed since it was generated)' : ''}`,
        ].join('\n'),
      );
    }
    case 'import': {
      // Copies a file (logo, font, image, icon) from the codebase into the project's assets/.
      const project = await getProject(slug);
      const source = path.resolve(project.codebase, String(opts.path || ''));
      if (!opts.path || !(source === project.codebase || source.startsWith(project.codebase + path.sep))) {
        throw new HttpError(400, `Only files inside the codebase (${project.codebase}) can be imported.`);
      }
      const stat = await fsp.stat(source).catch(() => null);
      if (!stat?.isFile()) throw new HttpError(404, `No file at ${source}`);
      if (stat.size > 50 * 1024 * 1024) throw new HttpError(400, 'That file is over 50 MB.');
      const name = path.basename(String(opts.name || path.basename(source))).replace(/[^\w.-]+/g, '-');
      const dest = path.join(projectDir(slug), 'assets', name);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(source, dest);
      return text(`Copied to assets/${name}. Use it in a scene as ../assets/${name}`);
    }
    case 'voice': {
      if (opts.generate) {
        const n = await generatePending(slug);
        if (!n) return text('Every voice-over line is already recorded.');
      }
      const st = await voiceStatus(slug);
      const project = await getProject(slug);
      const vo = st.voiceover;
      const out = [
        `Voice: ${vo.voice ? `${vo.voice.name} (${vo.voice.id})` : 'none picked yet (the user picks one in the Voice tab)'}; model ${vo.model}; ${st.characters} characters`,
        `Direction: ${vo.direction ?? ''}`,
      ];
      for (const sc of project.scenes) {
        if (scene && sc.id !== scene) continue;
        out.push(`${sc.id} "${sc.title}" (${sc.duration}s, room for ~${st.budgets[sc.id]} words):`);
        for (const l of st.lines.filter((x) => x.scene === sc.id)) {
          const state = !l.file ? 'not recorded' : l.stale ? 'changed since recorded' : `recorded ${l.duration?.toFixed(2)}s`;
          out.push(`  [${l.id}] at ${l.t.toFixed(2)}s → ends ~${(l.t + (l.end - l.start)).toFixed(2)}s · ${state} · "${l.text}"`);
          if (opts.words && l.words?.length) out.push(`      words: ${l.words.map((w) => `${w.w}@${w.s.toFixed(2)}`).join(' ')}`);
          for (const issue of l.issues) out.push(`      ⚠ ${issue}`);
        }
      }
      return text(out.join('\n'));
    }
    case 'sounds': {
      const st = await soundState(slug);
      const scenes = (await getProject(slug)).scenes;
      const lines = [
        `Library (${st.sounds.library.length}): ${st.sounds.library.map((d) => `${d.id}${st.available[d.id] ? '' : ' (not generated)'}`).join(', ')}`,
        `Whoosh on every cut: ${st.sounds.whooshOnCuts ? 'on' : 'off'}; effects level ${st.sounds.gain ?? 1}`,
      ];
      for (const sc of scenes) {
        if (scene && sc.id !== scene) continue;
        const cues = st.cues.filter((c) => c.scene === sc.id);
        const seen = new Set<string>();
        lines.push(`${sc.id}:${cues.length ? '' : ' no cues'}`);
        for (const c of cues) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          const count = cues.filter((x) => x.id === c.id).length;
          lines.push(`  ${c.local.toFixed(3)}s ${c.sound}${count > 1 ? ` ×${count}` : ''}${c.auto ? ' [auto]' : ` (id ${c.id}, gain ${c.gain})`}${c.muted ? ' MUTED' : ''}`);
        }
      }
      if (st.missing.length) lines.push(`Used but not generated yet: ${st.missing.join(', ')}`);
      return text(lines.join('\n'));
    }
    case 'snap': {
      const changes = await snapScenesToBeat(slug);
      if (changes.length) await ensureFreshScore(slug);
      return text(changes.length ? changes.map((c) => `${c.scene}: ${c.from}s → ${c.to}s`).join('\n') : 'Every cut is already on a beat.');
    }
    default:
      throw new HttpError(404, `Unknown command ${req.params.cmd}`);
  }
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---------------------------------------------------------------------------
// Watch project files: version every scene change, push live reloads to the editor.

function watchProjects() {
  const timers = new Map<string, NodeJS.Timeout>();
  fs.watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    const [slug, first] = parts;
    if (!slug || !first || first === '.story' || first === 'renders') return;
    const key = filename;
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(async () => {
        timers.delete(key);
        try {
          if (first === 'scenes' && parts.length === 3 && filename.endsWith('.html')) {
            const id = path.basename(filename, '.html');
            await snapshot(slug, id, activeLabel(slug) ?? 'Edited outside spindle/story');
            const stat = await fsp.stat(sceneFile(slug, id)).catch(() => null);
            if (stat) emit({ type: 'scene', project: slug, scene: id, version: Math.round(stat.mtimeMs) });
            emit({ type: 'project', project: slug });
          } else if (first === 'project.json') {
            emit({ type: 'project', project: slug });
          } else if (first === 'sounds.json' || first === 'voiceover.json') {
            emit({ type: 'sounds', project: slug });
          } else if (first === 'score.json') {
            // Only while the synth is the active soundtrack; never replace an ElevenLabs mix.
            const audio = (await getProject(slug)).audio;
            if (!selfWrites.has(slug) && audio?.provider !== 'elevenlabs') await renderScore(slug).catch(() => {});
          } else if (first === 'assets' && parts[1] === 'audio') {
            // Audio isn't used by scenes; no need to reload them.
          } else if (first === 'theme.css' || first === 'assets') {
            bumpAssets(slug);
            emit({ type: 'assets', project: slug, version: Date.now() });
            emit({ type: 'project', project: slug });
          }
        } catch {}
      }, 150),
    );
  });
}

// ---------------------------------------------------------------------------

async function main() {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  await seedExamples();
  watchProjects();

  if (process.env.NODE_ENV === 'production') {
    const dist = path.join(ROOT, 'dist');
    app.use(express.static(dist));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: { port: PORT + 1 } }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) res.status(status).json({ error: err.message || 'Something went wrong' });
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`\n  spindle/story → http://${HOST}:${PORT}\n  Projects in ${PROJECTS_DIR}\n`);
    // Needs the server up: re-rendering a score loads scenes over HTTP.
    migrateProjects().catch((e) => console.warn('Migration failed', e));
  });

  const shutdown = async () => {
    stopAll();
    await renderer.closeBrowser();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
