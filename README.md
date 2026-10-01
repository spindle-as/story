# spindle/story

Make launch videos and feature walkthroughs for a web project by prompting each scene. Every scene is an animated HTML page. Claude (through Claude Code) writes it, reads your codebase to rebuild the real UI, and renders frames to check its own work. The editor previews scenes live, and the exporter renders every frame in headless Chromium and encodes it to MP4.

```
npm install
npm run dev        # http://127.0.0.1:4300
```

Requirements: Node 22+, `ffmpeg` on your PATH, and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) logged in (`claude`, then `/login`) or `ANTHROPIC_API_KEY` set. Playwright's Chromium is used for thumbnails and export (`npx playwright install chromium` if it isn't installed yet).

## How it works

- **Projects** live in `projects/<slug>/` (or `$STORY_HOME`): `project.json` (canvas size, fps, scene order), `scenes/<id>.html`, `theme.css`, `art-direction.md`, `assets/`, and `renders/`. Everything is plain files, so you can open a scene in your editor ("Copy path") and the preview updates live.
- **Scenes** are HTML pages that load `/runtime/story.js` and add all their motion to one paused GSAP timeline with `Story.scene((tl) => …)`. The editor, the thumbnailer and the exporter all seek that timeline, so what you see is exactly what renders. All GSAP plugins (SplitText, DrawSVG, MorphSVG and so on) are bundled, along with Inter, Geist, Geist Mono, JetBrains Mono and Instrument Serif.
- **Chat**: each scene has its own Claude conversation, and so does the whole project. Claude runs headless in the project directory with your codebase added read-only (writes to it are denied). Your playhead position, the neighbouring scenes and the music beats inside the scene are sent along with every message. You can paste or drop reference images.
- **The `story` command** (`bin/story.mjs`) is what Claude uses to see its work: `story sheet` (contact sheet of frames), `story frames 0.5 1.2`, `story check` (JS errors, missing assets, timeline longer than the scene), `story seams` (pixel difference across each cut) and `story capture <url>` (screenshot of your running app into `assets/`), and for sound, `story sounds`, `story voice`, `story cues`, `story music [--generate]`, `story score [--mood …]` and `story snap`. You can run it yourself from inside a project folder too.
- **Versions**: every distinct state of a scene file is kept in `.story/versions`. Undo steps back, and the Versions dialog previews any state and restores it.
- **Soundtrack** (♪ in the transport): music by **ElevenLabs Music**, directed per scene. `music.json` holds the brief: styles for the whole track and one section per scene (or group of short scenes) with its own direction. Section lengths always come from the scenes, so the music changes on the cuts, and the tempo is chosen so cuts fall on beats. Pick a mood to start, edit the direction, or ask Claude to write it. Every generation is kept as a take you can listen to and switch between, and beats are detected in each take so "Snap cuts to the beat" works on the real music. The API key is saved in `~/.storyboard/settings.json` (or set `ELEVENLABS_API_KEY`) and is never sent to the browser or to Claude.
- **Sound design** (the Sound tab next to Scene and Project): sound effects are cues, a library sound at an exact moment of a scene, shown as markers on the timeline. Add one at the playhead, drag its marker to retime it, change its sound or level, or ask Claude ("a tick each time a checklist item is checked"). Cursor clicks make a click and typing makes one keystroke per character automatically; turn any automatic cue off. The library has UI presets (click, checkbox tick, toggle, keystroke, pop, success, whoosh, card slide, impact, riser, shimmer), sounds you describe in words, and your own uploads. Each is generated with ElevenLabs Sound Effects on demand, and "New take" makes another version to audition. The editor plays music and cues live; exports mix them at the exact cue times. Everything is in `sounds.json`.
- **Voice-over** (the Voice tab): a narration script on the timeline, read by an ElevenLabs voice. Each line belongs to a scene and starts at a scene time, so it moves with its scene. Every scene shows how many words fit (about 2.5 per second), and lines that would run into the next line or past the end are flagged before you spend credits. "Write with Claude" drafts the script from what each scene shows, following your direction for the tone. Pick a voice (with previews), record lines one by one or all at once (neighbouring lines are passed along so the read flows), and retake any line. Music dips under the voice in the editor and the export, and whole-video exports include captions (`.srt`) built from the spoken word timings. Everything is in `voiceover.json`.
- **Built-in synth**: an offline, free fallback in the same dialog. `score.json` (tempo, key, chords, instrument patterns) is rendered by a small Web Audio synthesizer. It sounds like a sketch, so use it for timing drafts.
- **Your own music**: alternatively, drop a track in Project settings. Beats and downbeats are detected in the browser, drawn on the timeline, and handed to Claude so cuts can land on the music. Exports mux the track and fade it out.
- **Export** (Render tab): the whole video or one scene, at 0.5×–2× the canvas size and 24–60 fps. Scenes render in parallel and are joined losslessly.

## Keyboard

Space play/pause · ←/→ one frame (Shift: one second) · ↑/↓ previous/next scene · Home/End · ⌘↵ send.

## Scripts

| | |
|---|---|
| `npm run dev` | Server with Vite middleware and auto-restart |
| `npm run build && npm start` | Production build, served by the same server |
| `npm test` | Unit tests (scene metadata, versions/undo, Claude context, music plans and ElevenLabs requests, sound cues, voice-over timing and captions, synth scores) |
| `npm run check` | Type-check client and server |

Environment: `PORT` (4300), `HOST` (127.0.0.1), `STORY_HOME` (projects directory), `CLAUDE_BIN` (path to `claude`), `STORY_MODEL` (default model; can also be set per project), `ELEVENLABS_API_KEY`, `ELEVENLABS_API_URL` (for testing against a mock).
# story
