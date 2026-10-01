<script lang="ts">
  import { Music, Pause, Play, Volume2, VolumeX } from '@lucide/svelte';
  import type { ResolvedCue } from '../../shared/sound';
  import { api } from '../lib/api';
  import { fmtTime, store } from '../lib/store.svelte';

  let track = $state<HTMLDivElement>();
  let width = $state(0);
  let dragging = $state(false);
  let wasPlaying = false;

  const duration = $derived(store.duration);
  const pct = (t: number) => (duration ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);

  const ticks = $derived.by(() => {
    if (!duration || !width) return [];
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => (width / duration) * s >= 70) ?? 60;
    const out: number[] = [];
    for (let t = 0; t <= duration + 1e-6; t += step) out.push(Number(t.toFixed(3)));
    return out;
  });

  const boundaries = $derived(store.mode === 'whole' ? store.starts.slice(1) : []);

  const beats = $derived.by(() => {
    const audio = store.project?.audio;
    if (!audio?.beats.length) return [];
    const base = (audio.offset || 0) + (store.mode === 'scene' ? (store.starts[store.sceneIndex] ?? 0) : 0);
    const downbeats = new Set(audio.downbeats.map((d) => d.toFixed(3)));
    return audio.beats
      .map((b) => ({ t: b - base, down: downbeats.has(b.toFixed(3)) }))
      .filter((b) => b.t >= 0 && b.t <= duration);
  });

  /** Sound cues on the track: the current scene's in scene mode, all of them for the whole video. */
  const cues = $derived.by(() => {
    const state = store.sounds;
    if (!state) return [];
    const sceneId = store.scenes[store.sceneIndex]?.id;
    const base = store.mode === 'scene' ? (store.starts[store.sceneIndex] ?? 0) : 0;
    return state.cues.filter((c) => store.mode === 'whole' || c.scene === sceneId).map((c) => ({ cue: c, at: c.t - base }));
  });

  /** Voice-over lines as spans on the track. */
  const voiceSpans = $derived.by(() => {
    const lines = store.voice?.lines ?? [];
    const base = store.mode === 'scene' ? (store.starts[store.sceneIndex] ?? 0) : 0;
    const sceneId = store.scenes[store.sceneIndex]?.id;
    return lines
      .filter((l) => l.text.trim() && (store.mode === 'whole' || l.scene === sceneId))
      .map((l) => ({ line: l, from: l.start - base, to: l.end - base }));
  });

  let cueDrag = $state<{ cue: ResolvedCue; x0: number; local: number; moved: boolean } | null>(null);

  function cueDown(e: PointerEvent, cue: ResolvedCue) {
    e.stopPropagation();
    cueDrag = { cue, x0: e.clientX, local: cue.local, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  }

  function cueMove(e: PointerEvent) {
    if (!cueDrag || cueDrag.cue.auto) return;
    const dx = e.clientX - cueDrag.x0;
    if (Math.abs(dx) > 2) cueDrag.moved = true;
    const sceneDuration = store.scenes.find((s) => s.id === cueDrag!.cue.scene)?.duration ?? duration;
    cueDrag.local = Math.min(sceneDuration, Math.max(0, cueDrag.cue.local + (dx / width) * duration));
  }

  async function cueUp() {
    const drag = cueDrag;
    if (!drag) return;
    if (!drag.moved) {
      // A click jumps to the cue and plays its sound.
      cueDrag = null;
      store.pause();
      const sceneStart = store.starts[store.scenes.findIndex((s) => s.id === drag.cue.scene)] ?? 0;
      store.seek(store.mode === 'scene' ? drag.cue.local : sceneStart + drag.cue.local);
      store.engine.preview(drag.cue.sound, drag.cue.gain);
      return;
    }
    const scene = drag.cue.scene;
    const cuesNow = store.sounds?.sounds.scenes[scene]?.cues ?? [];
    const next = cuesNow.map((c) => (c.id === drag.cue.id ? { ...c, t: Number(drag.local.toFixed(3)) } : c));
    if (store.sounds) store.sounds.sounds.scenes[scene] = { ...(store.sounds.sounds.scenes[scene] ?? { cues: [] }), cues: next };
    const out = await store.run(() => api.saveSceneSounds(store.project!.slug, scene, { cues: next }));
    cueDrag = null;
    if (out) await store.loadSounds();
  }

  function timeAt(clientX: number) {
    const rect = track!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * duration;
  }

  function down(e: PointerEvent) {
    dragging = true;
    wasPlaying = store.playing;
    store.pause();
    track!.setPointerCapture(e.pointerId);
    store.seek(timeAt(e.clientX));
  }
  function move(e: PointerEvent) {
    if (dragging) store.seek(timeAt(e.clientX));
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    if (wasPlaying) store.play();
  }
</script>

<div class="flex h-14 items-center gap-4 px-5">
  <div class="flex shrink-0 rounded-lg bg-raised p-0.5 text-[13px] font-medium">
    {#each [['scene', 'This scene'], ['whole', 'Whole video']] as [value, label]}
      <button
        class="rounded-md px-3 py-1.5 transition {store.mode === value ? 'bg-line text-fg shadow-sm' : 'text-muted hover:text-fg'}"
        onclick={() => store.setMode(value as 'scene' | 'whole')}>{label}</button
      >
    {/each}
  </div>

  <button
    class="grid size-10 shrink-0 place-items-center rounded-full bg-spindle text-ink transition hover:bg-spindle-hover active:scale-95"
    title="Play / pause (Space)"
    onclick={() => store.toggle()}
  >
    {#if store.playing}<Pause size={16} fill="currentColor" />{:else}<Play size={16} fill="currentColor" class="ml-0.5" />{/if}
  </button>

  <div class="tabular min-w-[104px] shrink-0 font-mono text-[14px] tracking-tight whitespace-nowrap text-fg">
    {fmtTime(store.time)} <span class="text-faint">/ {fmtTime(duration)}s</span>
  </div>

  <div class="relative min-w-0 flex-1 self-stretch">
    <div
      bind:this={track}
      bind:clientWidth={width}
      class="absolute inset-x-0 top-0 bottom-0 cursor-pointer touch-none"
      role="slider"
      tabindex="-1"
      aria-label="Playhead"
      aria-valuenow={store.time}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
    >
      <div class="absolute inset-x-0 top-[22px] h-[3px] rounded-full bg-line"></div>
      <div class="absolute left-0 top-[22px] h-[3px] rounded-full bg-spindle" style="width:{pct(store.time)}%"></div>
      {#each beats as beat}
        <div
          class="absolute top-[15px] w-px {beat.down ? 'h-[5px] bg-violet-500' : 'h-[3px] bg-violet-300'}"
          style="left:{pct(beat.t)}%"
        ></div>
      {/each}
      {#each voiceSpans as { line, from, to } (line.id)}
        <div
          class="pointer-events-none absolute top-[27px] h-[4px] rounded-full {line.file && !line.stale ? 'bg-teal-500/70' : 'border border-dashed border-teal-400 bg-transparent'} {line.issues.length ? 'ring-1 ring-amber-400' : ''}"
          style="left:{pct(from)}%;width:{Math.max(0.5, pct(to) - pct(from))}%"
          title={line.text}
        ></div>
      {/each}
      {#each cues as { cue, at } (cue.id + at)}
        {@const dragged = cueDrag?.cue.id === cue.id && cueDrag.moved}
        {@const x = dragged ? at + (cueDrag!.local - cue.local) : at}
        {#if cue.auto && cue.sound === 'keystroke'}
          <div class="pointer-events-none absolute top-[3px] h-[7px] w-px bg-amber-400/70 {cue.muted ? 'opacity-30' : ''}" style="left:{pct(x)}%"></div>
        {:else}
          <button
            class="absolute top-[1px] size-[11px] -translate-x-1/2 rounded-full border-2 border-ink shadow-sm transition-transform hover:scale-125
              {cue.auto ? 'bg-amber-400' : 'cursor-ew-resize bg-violet-600'} {cue.muted ? 'opacity-30' : ''} {dragged ? 'scale-125' : ''}"
            style="left:{pct(x)}%"
            title="{cue.label} at {(dragged ? cueDrag!.local : cue.local).toFixed(2)}s{cue.auto ? ' (automatic)' : ' · drag to move'}"
            aria-label="Sound cue {cue.label}"
            onpointerdown={(e) => cueDown(e, cue)}
            onpointermove={cueMove}
            onpointerup={cueUp}
          ></button>
        {/if}
      {/each}
      {#each boundaries as b}
        <div class="absolute top-[17px] h-[13px] w-[2px] -translate-x-1/2 rounded-full bg-muted" style="left:{pct(b)}%"></div>
      {/each}
      {#each ticks as t}
        <div class="absolute top-[33px] -translate-x-1/2 font-mono text-[10px] text-faint" style="left:{pct(t)}%">{t}s</div>
      {/each}
      <div
        class="absolute top-[13px] h-[21px] w-[5px] -translate-x-1/2 rounded-full bg-spindle shadow ring-2 ring-ink"
        style="left:{pct(store.time)}%"
      ></div>
    </div>
  </div>

  {#if store.project?.audio}
    <button
      class="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
      title={store.muted ? 'Unmute music' : 'Mute music'}
      onclick={() => store.toggleMute()}
    >
      {#if store.muted}<VolumeX size={16} />{:else}<Volume2 size={16} />{/if}
    </button>
  {/if}
  <button
    class="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition hover:bg-raised hover:text-fg {store.project?.audio ? 'text-violet-300' : 'text-muted'}"
    title="Soundtrack"
    onclick={() => (store.modal = 'soundtrack')}
  >
    {#if store.score.status === 'rendering'}
      <span class="size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-violet-600"></span>
    {:else}
      <Music size={15} />
    {/if}
    {store.project?.audio ? (store.project.audio.generated ? 'Score' : 'Music') : 'Add sound'}
  </button>
</div>
