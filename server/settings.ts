import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * App-wide settings that must not live inside a project (projects may be shared or committed).
 * Stored in ~/.storyboard/settings.json with owner-only permissions.
 */
const FILE = path.join(os.homedir(), '.storyboard', 'settings.json');

interface Settings {
  elevenlabsApiKey?: string;
}

async function read(): Promise<Settings> {
  try {
    return JSON.parse(await fsp.readFile(FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function write(settings: Settings) {
  await fsp.mkdir(path.dirname(FILE), { recursive: true, mode: 0o700 });
  await fsp.writeFile(FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/** ELEVENLABS_API_KEY in the environment wins over the saved key. */
export async function elevenLabsKey(): Promise<{ key: string | null; source: 'env' | 'file' | null }> {
  if (process.env.ELEVENLABS_API_KEY) return { key: process.env.ELEVENLABS_API_KEY, source: 'env' };
  const saved = (await read()).elevenlabsApiKey;
  return saved ? { key: saved, source: 'file' } : { key: null, source: null };
}

export async function setElevenLabsKey(key: string | null) {
  const settings = await read();
  if (key?.trim()) settings.elevenlabsApiKey = key.trim();
  else delete settings.elevenlabsApiKey;
  await write(settings);
}
