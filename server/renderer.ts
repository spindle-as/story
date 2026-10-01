import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { PNG } from 'pngjs';
import type { Project, RenderJob, RenderSettings, SceneInfo } from '../shared/types.ts';
import { emit } from './events.ts';
import { HttpError, internalDir, projectDir, SERVER_URL } from './paths.ts';
import { getProject } from './projects.ts';

let browserPromise: Promise<Browser> | null = null;

function browser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        args: ['--force-color-profile=srgb', '--hide-scrollbars', '--disable-lcd-text', '--font-render-hinting=none'],
      })
      .then((b) => {
        b.on('disconnected', () => (browserPromise = null));
        return b;
      });
    browserPromise.catch(() => (browserPromise = null));
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close().catch(() => {});
}

interface OpenScene {
  page: Page;
  context: BrowserContext;
  cdp: CDPSession;
  errors: string[];
  clip?: { x: number; y: number; width: number; height: number; scale: number };
  close(): Promise<void>;
}

function sceneUrl(project: Project, scene: SceneInfo) {
  return `${SERVER_URL}${scene.url}?render=1&w=${project.width}&h=${project.height}&v=${scene.version}`;
}

async function openScene(project: Project, scene: SceneInfo, scale = 1): Promise<OpenScene> {
  // Chromium ignores device scale factors below 1, so downscaling happens in capture().
  const context = await (await browser()).newContext({
    viewport: { width: project.width, height: project.height },
    deviceScaleFactor: Math.max(1, scale),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('requestfailed', (r) => errors.push(`Failed to load ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} for ${r.url()}`);
  });
  const close = () => context.close().catch(() => {});
  try {
    await page.goto(sceneUrl(project, scene), { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => (window as any).Story?.isReady === true, null, { timeout: 30_000 });
  } catch (e) {
    await close();
    const hint = errors.length ? `\n${errors.join('\n')}` : '';
    throw new HttpError(500, `Scene "${scene.id}" did not become ready: ${(e as Error).message.split('\n')[0]}${hint}`);
  }
  const runtimeErrors: string[] = await page.evaluate(() => (window as any).Story.errors);
  errors.push(...runtimeErrors);
  const cdp = await context.newCDPSession(page);
  return { page, context, cdp, errors, close, clip: scale < 1 ? { x: 0, y: 0, width: project.width, height: project.height, scale } : undefined };
}

async function capture(scene: OpenScene, t: number, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  await scene.page.evaluate((time) => (window as any).Story.seek(time, { wait: true }), t);
  const { data } = await scene.cdp.send('Page.captureScreenshot', {
    format,
    quality: format === 'jpeg' ? 88 : undefined,
    clip: scene.clip,
    optimizeForSpeed: true,
  });
  return Buffer.from(data, 'base64');
}

function findScene(project: Project, sceneId: string) {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new HttpError(404, `Scene not found: ${sceneId}`);
  return scene;
}

// ---------------------------------------------------------------------------
// Thumbnails

let thumbQueue: Promise<unknown> = Promise.resolve();

export async function thumbnail(slug: string, sceneId: string): Promise<string> {
  const project = await getProject(slug);
  const scene = findScene(project, sceneId);
  const dir = path.join(internalDir(slug), 'thumbs');
  const file = path.join(dir, `${sceneId}-${scene.version}-${project.assetsVersion}.jpg`);
  try {
    await fsp.access(file);
    return file;
  } catch {}
  const job = thumbQueue.then(async () => {
    try {
      await fsp.access(file);
      return;
    } catch {}
    await fsp.mkdir(dir, { recursive: true });
    const open = await openScene(project, scene, 480 / project.width);
    try {
      await fsp.writeFile(file, await capture(open, scene.poster, 'jpeg'));
    } finally {
      await open.close();
    }
    for (const old of await fsp.readdir(dir)) {
      if (old.startsWith(`${sceneId}-`) && path.join(dir, old) !== file) await fsp.rm(path.join(dir, old)).catch(() => {});
    }
  });
  thumbQueue = job.catch(() => {});
  await job;
  return file;
}

// ---------------------------------------------------------------------------
// Tools used by the agent through bin/story.mjs

const fmt = (t: number) => t.toFixed(2).replace(/\.?0+$/, '') || '0';

export async function frames(slug: string, sceneId: string, times: number[], scale = 0.5) {
  const project = await getProject(slug);
  const scene = findScene(project, sceneId);
  const dir = path.join(internalDir(slug), 'frames');
  await fsp.mkdir(dir, { recursive: true });
  const open = await openScene(project, scene, scale);
  try {
    const files: string[] = [];
    for (const t of times) {
      const file = path.join(dir, `${sceneId}@${fmt(t)}s.png`);
      await fsp.writeFile(file, await capture(open, Math.min(Math.max(0, t), scene.duration)));
      files.push(file);
    }
    return { files, errors: open.errors };
  } finally {
    await open.close();
  }
}

export async function contactSheet(slug: string, sceneId: string, opts: { count?: number; from?: number; to?: number; times?: number[] }) {
  const project = await getProject(slug);
  const scene = findScene(project, sceneId);
  const from = opts.from ?? 0;
  const to = Math.min(opts.to ?? scene.duration, scene.duration);
  const count = Math.max(2, Math.min(opts.count ?? 8, 24));
  const times =
    opts.times ?? Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1)).map((t) => Math.min(t, to - 1 / project.fps));
  const open = await openScene(project, scene, 480 / project.width);
  const shots: { t: number; data: string }[] = [];
  try {
    for (const t of times) shots.push({ t, data: (await capture(open, t, 'jpeg')).toString('base64') });
  } finally {
    await open.close();
  }
  const cols = shots.length <= 4 ? shots.length : shots.length <= 9 ? 3 : 4;
  const page = await (await browser()).newPage({ viewport: { width: cols * 490 + 10, height: 400 } });
  try {
    await page.setContent(`<!doctype html><body style="margin:0;padding:5px;background:#222;font:600 15px system-ui;color:#fff">
      <div style="display:grid;grid-template-columns:repeat(${cols},480px);gap:10px">
      ${shots.map((s) => `<figure style="margin:0"><img style="display:block;width:480px;border-radius:4px" src="data:image/jpeg;base64,${s.data}"><figcaption style="padding:4px 2px 2px">${s.t.toFixed(2)}s</figcaption></figure>`).join('')}
      </div></body>`);
    const dir = path.join(internalDir(slug), 'frames');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sceneId}-sheet.png`);
    await page.screenshot({ path: file, fullPage: true });
    return { file, times, errors: open.errors };
  } finally {
    await page.close();
  }
}

export async function check(slug: string, sceneId?: string) {
  const project = await getProject(slug);
  const scenes = sceneId ? [findScene(project, sceneId)] : project.scenes;
  const results = [];
  for (const scene of scenes) {
    try {
      const open = await openScene(project, scene, 0.25);
      try {
        const info = await open.page.evaluate(() => {
          const S = (window as any).Story;
          return { declared: S.duration as number, timeline: S.timeline.duration() as number };
        });
        const warnings: string[] = [];
        if (info.timeline > info.declared + 0.01) {
          warnings.push(
            `Timeline runs ${info.timeline.toFixed(2)}s but the scene is ${info.declared}s long; animations after ${info.declared}s are cut off.`,
          );
        }
        if (info.timeline < 0.05) warnings.push('Timeline is empty; nothing animates.');
        results.push({ scene: scene.id, ok: open.errors.length === 0, duration: info.declared, timeline: info.timeline, errors: open.errors, warnings });
      } finally {
        await open.close();
      }
    } catch (e) {
      results.push({ scene: scene.id, ok: false, errors: [(e as Error).message], warnings: [] });
    }
  }
  return results;
}

function decode(buf: Buffer) {
  return PNG.sync.read(buf);
}

export async function seams(slug: string) {
  const project = await getProject(slug);
  const out = [];
  for (let i = 0; i < project.scenes.length - 1; i++) {
    const a = project.scenes[i];
    const b = project.scenes[i + 1];
    const openA = await openScene(project, a, 0.5);
    const last = await capture(openA, Math.max(0, a.duration - 1 / project.fps)).finally(() => openA.close());
    const openB = await openScene(project, b, 0.5);
    const first = await capture(openB, 0).finally(() => openB.close());
    const pa = decode(last);
    const pb = decode(first);
    const diff = pixelmatch(pa.data, pb.data, undefined, pa.width, pa.height, { threshold: 0.1 });
    out.push({ from: a.id, to: b.id, diffPercent: Number(((diff / (pa.width * pa.height)) * 100).toFixed(2)) });
  }
  return out;
}

export async function captureUrl(
  slug: string,
  opts: { url: string; selector?: string; name?: string; width?: number; height?: number; dark?: boolean; fullPage?: boolean; wait?: number },
) {
  if (!/^https?:\/\//.test(opts.url)) throw new HttpError(400, 'URL must start with http:// or https://');
  const context = await (await browser()).newContext({
    viewport: { width: opts.width || 1440, height: opts.height || 900 },
    deviceScaleFactor: 2,
    colorScheme: opts.dark ? 'dark' : 'light',
  });
  try {
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 45_000 });
    if (opts.wait) await page.waitForTimeout(opts.wait * 1000);
    const name = (opts.name || new URL(opts.url).pathname.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'capture').replace(/\.png$/, '');
    const file = path.join(projectDir(slug), 'assets', `${name}.png`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (opts.selector) await page.locator(opts.selector).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: !!opts.fullPage });
    const png = PNG.sync.read(await fsp.readFile(file));
    return { file, relative: `../assets/${name}.png`, width: png.width / 2, height: png.height / 2 };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Soundtrack: sound cues from scenes, and synthesis in the browser

export interface SceneCue {
  type: string;
  t: number;
  d?: number;
  chars?: number;
  gain?: number;
  pan?: number;
  source: 'scene' | 'helper';
}

/** Loads every scene and reads its sound cues (Story.sound calls, clicks, typing) plus its timeline length. */
export async function collectCues(slug: string, only?: Set<string>) {
  const project = await getProject(slug);
  const scenes: { id: string; start: number; duration: number; timeline: number; cues: SceneCue[]; error?: string }[] = [];
  let start = 0;
  for (const scene of project.scenes) {
    const entry = { id: scene.id, start, duration: scene.duration, timeline: scene.duration, cues: [] as SceneCue[], error: undefined as string | undefined };
    if (only && !only.has(scene.id)) {
      scenes.push(entry);
      start += scene.duration;
      continue;
    }
    try {
      const open = await openScene(project, scene, 0.25);
      try {
        const info = await open.page.evaluate(() => {
          const S = (window as any).Story;
          return { cues: typeof S.cues === 'function' ? S.cues() : [], timeline: S.timeline.duration() as number };
        });
        entry.cues = info.cues;
        entry.timeline = info.timeline;
      } finally {
        await open.close();
      }
    } catch (e) {
      entry.error = (e as Error).message.split('\n')[0];
    }
    scenes.push(entry);
    start += scene.duration;
  }
  return { scenes, duration: start, cuts: scenes.slice(1).map((s) => s.start) };
}

/** Renders synth events (see shared/score.ts) to a WAV with runtime/synth.js in headless Chromium. */
export async function synthesize(
  events: unknown[],
  opts: {
    duration: number;
    master?: unknown;
    bed?: { url: string; gain?: number; offset?: number; duck?: { ranges: [number, number][]; level: number } };
    samples?: Record<string, string>;
    anchors?: Record<string, 'onset' | 'peak' | 'start'>;
    samplesOnly?: boolean;
  },
) {
  const page = await (await browser()).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${SERVER_URL}/runtime/synth.html`);
    await page.waitForFunction(() => !!(window as any).StorySynth, null, { timeout: 15_000 });
    const out = await page.evaluate(
      async ({ events, opts }) => {
        const synth = (window as any).StorySynth;
        const buffer = await synth.render(events, opts);
        return synth.encodeWav(buffer);
      },
      { events, opts },
    );
    return { wav: Buffer.from(out.base64, 'base64'), peakDb: out.peakDb as number, rmsDb: out.rmsDb as number, gainDb: out.gainDb as number, errors };
  } finally {
    await page.close();
  }
}

/** Tempo, beats and downbeats of an audio file served by this app (e.g. a generated take). */
export async function analyzeAudio(url: string): Promise<{ duration: number; bpm: number; beats: number[]; downbeats: number[] }> {
  const page = await (await browser()).newPage();
  try {
    await page.goto(`${SERVER_URL}/runtime/synth.html`);
    await page.waitForFunction(() => !!(window as any).StoryBeats, null, { timeout: 15_000 });
    return await page.evaluate(async (src) => {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${src}`);
      return (window as any).StoryBeats.analyzeBeats(await res.arrayBuffer());
    }, url);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Video export

const jobs = new Map<string, RenderJob>();
const cancelled = new Set<string>();
const children = new Map<string, Set<ChildProcess>>();

const rendersFile = (slug: string) => path.join(internalDir(slug), 'renders.json');

export async function listRenders(slug: string): Promise<RenderJob[]> {
  let saved: RenderJob[] = [];
  try {
    saved = JSON.parse(await fsp.readFile(rendersFile(slug), 'utf8'));
  } catch {}
  const live = [...jobs.values()].filter((j) => j.project === slug);
  const merged = [...live, ...saved.filter((s) => !jobs.has(s.id))];
  const existing: RenderJob[] = [];
  for (const job of merged) {
    if (job.status === 'done' && job.file) {
      try {
        await fsp.access(job.file);
      } catch {
        continue;
      }
    }
    existing.push(job);
  }
  return existing.sort((a, b) => b.startedAt - a.startedAt);
}

async function persist(job: RenderJob) {
  let saved: RenderJob[] = [];
  try {
    saved = JSON.parse(await fsp.readFile(rendersFile(job.project), 'utf8'));
  } catch {}
  saved = [job, ...saved.filter((s) => s.id !== job.id)].slice(0, 50);
  await fsp.writeFile(rendersFile(job.project), JSON.stringify(saved, null, 2));
}

function run(jobId: string, args: string[], stdin = false): { proc: ChildProcess; done: Promise<void> } {
  const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'],
  });
  const set = children.get(jobId) ?? new Set();
  set.add(proc);
  children.set(jobId, set);
  let stderr = '';
  proc.stderr!.on('data', (d) => (stderr += d));
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      set.delete(proc);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().slice(-800)}`));
    });
  });
  return { proc, done };
}

function write(proc: ChildProcess, buf: Buffer) {
  return new Promise<void>((resolve, reject) => {
    proc.stdin!.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

/** `audio` is the file to mux (the sound mix or the music); null renders without sound. */
export async function startRender(
  slug: string,
  settings: RenderSettings,
  audioFile?: { file: string; offset: number } | null,
  captions?: string,
): Promise<RenderJob> {
  const project = await getProject(slug);
  const scenes = settings.scope === 'all' ? project.scenes : [findScene(project, settings.scope)];
  if (!scenes.length) throw new HttpError(400, 'No scenes to render');
  const fps = Math.max(1, Math.min(120, settings.fps || project.fps));
  const scale = Math.max(0.25, Math.min(4, settings.scale || 1));

  // Frame boundaries come from cumulative time, so rounding never drifts across scenes.
  let cursor = 0;
  const plan = scenes.map((scene) => {
    const start = cursor;
    cursor += scene.duration;
    return { scene, start, first: Math.round(start * fps), last: Math.round(cursor * fps) };
  });
  const duration = cursor;
  const totalFrames = plan.at(-1)!.last;

  const job: RenderJob = {
    id: `${Date.now().toString(36)}`,
    project: slug,
    status: 'rendering',
    frames: 0,
    totalFrames,
    startedAt: Date.now(),
    settings: { ...settings, fps, scale },
    width: Math.round(project.width * scale),
    height: Math.round(project.height * scale),
    duration,
  };
  jobs.set(job.id, job);
  emit({ type: 'render', project: slug, job });

  let lastEmit = 0;
  const progress = (force = false) => {
    if (force || Date.now() - lastEmit > 200) {
      lastEmit = Date.now();
      emit({ type: 'render', project: slug, job });
    }
  };

  const tmp = path.join(internalDir(slug), 'render-tmp', job.id);
  const audio = settings.audio && settings.scope === 'all' ? (audioFile === undefined ? project.audio ?? null : audioFile) : null;

  (async () => {
    await fsp.mkdir(tmp, { recursive: true });
    const segments = plan.map((_, i) => path.join(tmp, `${String(i).padStart(3, '0')}.mp4`));
    const queue = plan.map((p, i) => ({ ...p, out: segments[i] }));
    const workers = Math.max(1, Math.min(queue.length, Math.floor(os.cpus().length / 3), 4));

    const renderSegment = async (item: (typeof queue)[number]) => {
      const open = await openScene(project, item.scene, scale);
      const ff = run(
        job.id,
        ['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p',
          '-r', String(fps), '-video_track_timescale', String(fps * 1000), item.out],
        true,
      );
      try {
        for (let f = item.first; f < item.last; f++) {
          if (cancelled.has(job.id)) throw new Error('cancelled');
          const t = Math.min(f / fps - item.start, item.scene.duration - 1e-4);
          await write(ff.proc, await capture(open, Math.max(0, t)));
          job.frames++;
          progress();
        }
        ff.proc.stdin!.end();
        await ff.done;
      } catch (e) {
        ff.proc.kill('SIGKILL');
        throw e;
      } finally {
        await open.close();
      }
    };

    let next = 0;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < queue.length) await renderSegment(queue[next++]);
      }),
    );

    job.status = 'encoding';
    progress(true);
    const list = path.join(tmp, 'list.txt');
    await fsp.writeFile(list, segments.map((s) => `file '${s}'`).join('\n'));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = settings.scope === 'all' ? slug : `${slug}-${settings.scope}`;
    const out = path.join(projectDir(slug), 'renders', `${name}-${stamp}.mp4`);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const args = ['-f', 'concat', '-safe', '0', '-i', list];
    if (audio) {
      const fade = Math.min(1.5, duration / 4);
      args.push('-ss', String(audio.offset || 0), '-i', path.join(projectDir(slug), audio.file),
        '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '256k',
        '-af', `apad,afade=t=out:st=${(duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`, '-t', duration.toFixed(3));
    }
    args.push('-c:v', 'copy', '-movflags', '+faststart', out);
    await run(job.id, args).done;

    job.status = 'done';
    job.file = out;
    job.url = `/p/${slug}/renders/${path.basename(out)}`;
    job.size = (await fsp.stat(out)).size;
    if (captions) {
      const srt = out.replace(/\.mp4$/, '.srt');
      await fsp.writeFile(srt, captions);
      job.captionsUrl = `/p/${slug}/renders/${path.basename(srt)}`;
    }
  })()
    .catch((e) => {
      job.status = cancelled.has(job.id) ? 'cancelled' : 'error';
      job.error = job.status === 'error' ? (e as Error).message : undefined;
    })
    .finally(async () => {
      job.finishedAt = Date.now();
      cancelled.delete(job.id);
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      await persist(job).catch(() => {});
      jobs.delete(job.id);
      progress(true);
    });

  return job;
}

export function cancelRender(jobId: string) {
  cancelled.add(jobId);
  for (const proc of children.get(jobId) ?? []) proc.kill('SIGKILL');
}
