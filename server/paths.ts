import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECTS_DIR = path.resolve(process.env.STORY_HOME || path.join(ROOT, 'projects'));
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const RUNTIME_DIR = path.join(ROOT, 'runtime');
export const BIN_DIR = path.join(ROOT, 'bin');
export const PORT = Number(process.env.PORT || 4300);
export const HOST = process.env.HOST || '127.0.0.1';
export const SERVER_URL = `http://${HOST}:${PORT}`;

export const projectDir = (slug: string) => path.join(PROJECTS_DIR, slug);
export const internalDir = (slug: string) => path.join(projectDir(slug), '.story');
export const sceneFile = (slug: string, sceneId: string) => path.join(projectDir(slug), 'scenes', `${sceneId}.html`);

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'untitled'
  );
}

/** Rejects ids that could escape their directory. */
export function assertId(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new HttpError(400, `Invalid id: ${id}`);
  return id;
}

/** A chat scope is a scene id, or `_project` for the project-wide chat. */
export function assertScope(scope: string): string {
  return scope === '_project' ? scope : assertId(scope);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
