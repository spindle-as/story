#!/usr/bin/env node
// The `story` command. Claude runs it (via Bash) to look at and verify the scenes it writes.
// It talks to the running spindle/story server, which keeps a warm headless browser.
import fs from 'node:fs';
import path from 'node:path';

const HELP = `story <command> [scene] [options]

  sheet   [scene] [--count 8] [--from s] [--to s]   Contact sheet of frames across time (prints PNG path)
  frames  [scene] <t> [t...] [--scale 0.5]          Frames at exact times in seconds (prints PNG paths)
  check   [scene]                                    JS errors, failed loads, timeline/duration mismatch (all scenes if omitted)
  seams                                              Pixel difference across every cut
  capture <url> [--selector css] [--name file] [--dark] [--width 1440] [--height 900] [--full] [--wait s]
                                                     Screenshot of the running app into assets/
  scenes                                             List scenes with start times and durations
  import <path> [--name file]                        Copy a file from the codebase (logo, font, image) into assets/
  cues                                               Sound cues in every scene (clicks, typing, Story.sound) and the cut times
  score [--mood minimal|upbeat|cinematic|ambient] [--bpm n] [--key D] [--sfx off]
                                                     Render score.json to the soundtrack (with --mood: compose a fresh score first)
  snap                                               Nudge scene lengths so every cut lands on a beat of the soundtrack
  music [--generate]                                 Show the ElevenLabs music plan; --generate makes a new take (costs credits)
  sounds [scene]                                     Sound library and every sound cue (automatic and placed) per scene
  voice [scene] [--words] [--generate]               Voice-over lines with timing, fit and word budgets; --words adds per-word
                                                     timings; --generate records new or changed lines (costs credits)

The scene defaults to $STORY_SCENE (the scene you are chatting about).`;

function findProject() {
  if (process.env.STORY_PROJECT) return process.env.STORY_PROJECT;
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'project.json'))) return path.basename(dir);
    dir = path.dirname(dir);
  }
  return null;
}

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
  process.exit(0);
}

const positional = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=');
    const next = argv[i + 1];
    if (inline !== undefined) opts[k] = inline;
    else if (next !== undefined && !next.startsWith('--')) opts[k] = argv[++i];
    else opts[k] = true;
  } else positional.push(a);
}
for (const k of ['count', 'from', 'to', 'scale', 'width', 'height', 'wait', 'bpm']) {
  if (k in opts) opts[k] = Number(opts[k]);
}

const isTime = (x) => /^-?\d*\.?\d+s?$/.test(x);
// Project-wide commands ignore the current scene.
const projectWide = new Set(['seams', 'scenes', 'cues', 'score', 'snap', 'music', 'import']);
const body = { project: findProject(), scene: projectWide.has(cmd) ? undefined : process.env.STORY_SCENE || undefined, ...opts };

switch (cmd) {
  case 'frames':
    if (positional[0] && !isTime(positional[0])) body.scene = positional.shift();
    body.times = positional.map((t) => parseFloat(t));
    break;
  case 'sheet':
  case 'check':
  case 'sounds':
  case 'voice':
    if (positional[0]) body.scene = positional[0];
    else if ((cmd === 'check' || cmd === 'sounds' || cmd === 'voice') && !process.env.STORY_SCENE) body.scene = undefined;
    break;
  case 'import':
    body.path = positional[0];
    break;
  case 'capture':
    body.url = positional[0];
    if (opts.full) body.fullPage = true;
    break;
}

if (!body.project) {
  console.error('Not inside a spindle/story project (no project.json found).');
  process.exit(1);
}

const server = process.env.STORY_SERVER || 'http://127.0.0.1:4300';
try {
  const res = await fetch(`${server}/api/tools/${cmd}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error;
    } catch {}
    console.error(message);
    process.exit(1);
  }
  process.stdout.write(text);
} catch (e) {
  console.error(`Could not reach spindle/story at ${server}. Is the app running? (${e.message})`);
  process.exit(1);
}
