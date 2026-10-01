import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Project, ProjectConfig, ProjectSummary, SceneInfo, Version } from '../shared/types.ts';
import {
  assertId,
  HttpError,
  internalDir,
  PROJECTS_DIR,
  projectDir,
  sceneFile,
  slugify,
  TEMPLATES_DIR,
} from './paths.ts';

/** Scenes/scopes that currently have an agent turn running. Set by agent.ts. */
export const busy = new Set<string>();
export const busyKey = (slug: string, scope: string) => `${slug}:${scope}`;

/** Bumped whenever theme.css or assets change, so iframes reload. */
const assetsVersions = new Map<string, number>();
export const bumpAssets = (slug: string) => assetsVersions.set(slug, Date.now());

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

export function parseSceneMeta(html: string) {
  const meta = (name: string) =>
    html.match(new RegExp(`<meta\\s+name=["']story:${name}["']\\s+content=["']([^"']*)["']`, 'i'))?.[1];
  const duration = Number(meta('duration'));
  const poster = Number(meta('poster'));
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 3;
  return {
    duration: safeDuration,
    poster: Number.isFinite(poster) && meta('poster') ? Math.min(poster, safeDuration) : Number((safeDuration * 0.6).toFixed(3)),
    tags: (meta('tags') || '').split(',').map((t) => t.trim()).filter(Boolean),
  };
}

export async function readConfig(slug: string): Promise<ProjectConfig> {
  assertId(slug);
  try {
    return JSON.parse(await fsp.readFile(path.join(projectDir(slug), 'project.json'), 'utf8'));
  } catch {
    throw new HttpError(404, `Project not found: ${slug}`);
  }
}

export async function writeConfig(slug: string, config: ProjectConfig) {
  await fsp.writeFile(path.join(projectDir(slug), 'project.json'), JSON.stringify(config, null, 2) + '\n');
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  const out: ProjectSummary[] = [];
  for (const entry of await fsp.readdir(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const project = await getProject(entry.name);
      const stat = await fsp.stat(path.join(project.dir, 'project.json'));
      out.push({
        slug: project.slug,
        name: project.name,
        codebase: project.codebase,
        scenes: project.scenes.length,
        duration: project.scenes.reduce((s, x) => s + x.duration, 0),
        updatedAt: stat.mtimeMs,
      });
    } catch {
      // Not a project directory.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(slug: string): Promise<Project> {
  const config = await readConfig(slug);
  const scenes: SceneInfo[] = [];
  for (const entry of config.scenes) {
    const file = sceneFile(slug, entry.id);
    let html = '';
    let version = 0;
    try {
      html = await fsp.readFile(file, 'utf8');
      version = (await fsp.stat(file)).mtimeMs;
    } catch {
      continue;
    }
    let versions = (await readVersions(slug, entry.id)).length;
    // A baseline makes the first edit undoable, even for files created outside the app.
    if (!versions && (await snapshot(slug, entry.id, 'Original'))) versions = 1;
    scenes.push({
      ...entry,
      ...parseSceneMeta(html),
      file,
      url: `/p/${slug}/scenes/${entry.id}.html`,
      version: Math.round(version),
      versions,
      busy: busy.has(busyKey(slug, entry.id)),
    });
  }
  const { scenes: _scenes, ...rest } = config;
  return {
    ...rest,
    slug,
    dir: projectDir(slug),
    scenes,
    projectBusy: busy.has(busyKey(slug, '_project')),
    assetsVersion: assetsVersions.get(slug) ?? 0,
  };
}

export async function createProject(input: {
  name: string;
  codebase: string;
  url?: string;
  width?: number;
  height?: number;
  fps?: number;
}): Promise<string> {
  const name = input.name.trim() || 'Untitled';
  const codebase = path.resolve(input.codebase.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  if (!(await exists(codebase))) throw new HttpError(400, `Codebase not found: ${codebase}`);

  let slug = slugify(name);
  for (let i = 2; await exists(projectDir(slug)); i++) slug = `${slugify(name)}-${i}`;

  const dir = projectDir(slug);
  await fsp.mkdir(path.join(dir, 'scenes'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fsp.mkdir(internalDir(slug), { recursive: true });
  await fsp.copyFile(path.join(TEMPLATES_DIR, 'theme.css'), path.join(dir, 'theme.css'));
  await fsp.copyFile(path.join(TEMPLATES_DIR, 'art-direction.md'), path.join(dir, 'art-direction.md'));
  await fsp.writeFile(path.join(dir, '.gitignore'), '.story/\nrenders/\n');

  const config: ProjectConfig = {
    name,
    codebase,
    url: input.url?.trim() || undefined,
    width: input.width || 1920,
    height: input.height || 1080,
    fps: input.fps || 60,
    scenes: [],
    createdAt: new Date().toISOString(),
  };
  await writeConfig(slug, config);
  await createScene(slug, { title: name });
  return slug;
}

export async function updateProject(slug: string, patch: Partial<ProjectConfig>) {
  const config = await readConfig(slug);
  const allowed: (keyof ProjectConfig)[] = ['name', 'codebase', 'url', 'width', 'height', 'fps', 'model', 'audio'];
  for (const key of allowed) {
    if (key in patch) (config as any)[key] = patch[key];
  }
  await writeConfig(slug, config);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export async function createScene(
  slug: string,
  opts: { title: string; after?: string; html?: string },
): Promise<string> {
  const config = await readConfig(slug);
  const base = slugify(opts.title) || 'scene';
  let id = base;
  for (let i = 2; config.scenes.some((s) => s.id === id) || (await exists(sceneFile(slug, id))); i++) {
    id = `${base}-${i}`;
  }
  const html =
    opts.html ??
    (await fsp.readFile(path.join(TEMPLATES_DIR, 'scene.html'), 'utf8')).replace('{{title}}', escapeHtml(opts.title));
  await fsp.mkdir(path.dirname(sceneFile(slug, id)), { recursive: true });
  await fsp.writeFile(sceneFile(slug, id), html);

  const index = opts.after ? config.scenes.findIndex((s) => s.id === opts.after) : -1;
  const entry = { id, title: opts.title };
  if (index >= 0) config.scenes.splice(index + 1, 0, entry);
  else config.scenes.push(entry);
  await writeConfig(slug, config);
  await snapshot(slug, id, 'Created');
  return id;
}

export async function duplicateScene(slug: string, sceneId: string) {
  const config = await readConfig(slug);
  const source = config.scenes.find((s) => s.id === assertId(sceneId));
  if (!source) throw new HttpError(404, 'Scene not found');
  const html = await fsp.readFile(sceneFile(slug, sceneId), 'utf8');
  return createScene(slug, { title: `${source.title} copy`, after: sceneId, html });
}

export async function updateScene(slug: string, sceneId: string, patch: { title?: string }) {
  const config = await readConfig(slug);
  const scene = config.scenes.find((s) => s.id === assertId(sceneId));
  if (!scene) throw new HttpError(404, 'Scene not found');
  if (patch.title?.trim()) scene.title = patch.title.trim();
  await writeConfig(slug, config);
}

/** Moves the scene file to .story/trash so a delete is never destructive. */
export async function deleteScene(slug: string, sceneId: string) {
  const config = await readConfig(slug);
  config.scenes = config.scenes.filter((s) => s.id !== assertId(sceneId));
  const trash = path.join(internalDir(slug), 'trash');
  await fsp.mkdir(trash, { recursive: true });
  await fsp.rename(sceneFile(slug, sceneId), path.join(trash, `${sceneId}-${Date.now()}.html`)).catch(() => {});
  await writeConfig(slug, config);
}

export async function reorderScenes(slug: string, ids: string[]) {
  const config = await readConfig(slug);
  const byId = new Map(config.scenes.map((s) => [s.id, s]));
  const ordered = ids.map((id) => byId.get(id)).filter((s) => !!s);
  const missing = config.scenes.filter((s) => !ids.includes(s.id));
  config.scenes = [...ordered, ...missing];
  await writeConfig(slug, config);
}

// ---------------------------------------------------------------------------
// Versions: every distinct state of a scene file is kept, append-only.

const versionsDir = (slug: string, sceneId: string) => path.join(internalDir(slug), 'versions', sceneId);

export async function readVersions(slug: string, sceneId: string): Promise<Version[]> {
  try {
    return JSON.parse(await fsp.readFile(path.join(versionsDir(slug, sceneId), 'index.json'), 'utf8'));
  } catch {
    return [];
  }
}

/** Records the current file as a version unless identical content is already stored. */
export async function snapshot(slug: string, sceneId: string, label: string): Promise<Version | null> {
  let html: string;
  try {
    html = await fsp.readFile(sceneFile(slug, sceneId), 'utf8');
  } catch {
    return null;
  }
  const h = hash(html);
  const versions = await readVersions(slug, sceneId);
  // Restoring an old version writes content we already have; don't store it twice.
  if (versions.some((v) => v.hash === h)) return null;
  const version: Version = { id: `${Date.now()}-${h}`, ts: Date.now(), hash: h, label, duration: parseSceneMeta(html).duration };
  const dir = versionsDir(slug, sceneId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${version.id}.html`), html);
  versions.push(version);
  await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(versions, null, 2));
  return version;
}

export async function currentVersionIndex(slug: string, sceneId: string): Promise<number> {
  const html = await fsp.readFile(sceneFile(slug, sceneId), 'utf8').catch(() => '');
  const h = hash(html);
  const versions = await readVersions(slug, sceneId);
  return versions.findLastIndex((v) => v.hash === h);
}

export async function readVersion(slug: string, sceneId: string, versionId: string) {
  if (!/^[\w-]+$/.test(versionId)) throw new HttpError(400, 'Invalid version');
  return fsp.readFile(path.join(versionsDir(slug, sceneId), `${versionId}.html`), 'utf8');
}

/** Restoring writes the old content back. It matches an existing version, so no duplicate is stored. */
export async function restoreVersion(slug: string, sceneId: string, versionId: string) {
  const html = await readVersion(slug, sceneId, versionId);
  await fsp.writeFile(sceneFile(slug, sceneId), html);
}

/** Steps back one version from whatever the file currently matches. */
export async function undo(slug: string, sceneId: string): Promise<boolean> {
  let index = await currentVersionIndex(slug, sceneId);
  if (index < 0) {
    await snapshot(slug, sceneId, 'Unsaved edit');
    index = (await readVersions(slug, sceneId)).length - 1;
  }
  const versions = await readVersions(slug, sceneId);
  const previous = versions[index - 1];
  if (!previous) return false;
  await restoreVersion(slug, sceneId, previous.id);
  return true;
}

// ---------------------------------------------------------------------------

export async function readProjectText(slug: string, file: 'art-direction.md' | 'theme.css') {
  return fsp.readFile(path.join(projectDir(slug), file), 'utf8').catch(() => '');
}

export async function writeProjectText(slug: string, file: 'art-direction.md' | 'theme.css', content: string) {
  await fsp.writeFile(path.join(projectDir(slug), file), content);
}

export function sceneExists(slug: string, sceneId: string) {
  return fs.existsSync(sceneFile(slug, sceneId));
}
