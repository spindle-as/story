<script lang="ts">
  import { untrack } from 'svelte';
  import type { SceneInfo } from '../../shared/types';
  import { api } from '../lib/api';
  import { store } from '../lib/store.svelte';

  let { dark = false }: { dark?: boolean } = $props();

  interface Frame {
    src: string;
    sceneId: string;
    ready: boolean;
    errors: string[];
    el?: HTMLIFrameElement;
  }

  let cw = $state(0);
  let ch = $state(0);
  let frames = $state<Frame[]>([]);

  const W = $derived(store.project?.width ?? 1920);
  const H = $derived(store.project?.height ?? 1080);
  const scale = $derived(cw && ch ? Math.min(cw / W, ch / H) : 0);

  const wanted = $derived.by(() => {
    const s = store.scenes;
    const i = store.activeIndex;
    if (store.mode === 'scene') return s[i] ? [s[i]] : [];
    return [s[i], s[i + 1], s[i - 1]].filter((x): x is SceneInfo => !!x);
  });

  function srcFor(scene: SceneInfo) {
    const v = store.reloadKeys[scene.id] ?? scene.version;
    return `${scene.url}?embed=1&w=${W}&h=${H}&v=${v}-${store.assetsKey}`;
  }

  // Mount wanted scenes. A changed file mounts a second iframe; the old one stays visible until the new one is ready.
  $effect(() => {
    const desired = wanted.map((scene) => ({ sceneId: scene.id, src: srcFor(scene) }));
    untrack(() => {
      const next = frames.filter((f) => desired.some((d) => d.sceneId === f.sceneId));
      for (const d of desired) {
        if (!next.some((f) => f.src === d.src)) next.push({ ...d, ready: false, errors: [] });
      }
      if (next.length !== frames.length || next.some((f, i) => f !== frames[i])) frames = next;
    });
  });

  const win = (f: Frame) => f.el?.contentWindow as (Window & { Story?: any }) | null | undefined;

  function visibleFrame(sceneId: string | undefined) {
    const candidates = frames.filter((f) => f.sceneId === sceneId);
    return candidates.findLast((f) => f.ready) ?? null;
  }

  const active = $derived(visibleFrame(store.scenes[store.activeIndex]?.id));
  const loading = $derived(!active && wanted.length > 0);

  function onLoad(frame: Frame) {
    const story = win(frame)?.Story;
    const done = () => {
      frame.ready = true;
      frame.errors = [...(win(frame)?.Story?.errors ?? [])];
      // Retire older iframes of the same scene.
      const index = frames.indexOf(frame);
      frames = frames.filter((f, i) => f.sceneId !== frame.sceneId || i >= index);
      positionNeighbours();
    };
    if (!story) {
      frame.errors = ['The scene runtime did not load. Check that the scene includes /runtime/story.js.'];
      frame.ready = true;
      return;
    }
    story.ready.then(done);
  }

  function seekFrame(frame: Frame, t: number) {
    const story = win(frame)?.Story;
    if (!story?.isReady) return;
    try {
      story.seek(t);
      if (story.errors.length !== frame.errors.length) frame.errors = [...story.errors];
    } catch (e) {
      frame.errors = [String(e)];
    }
  }

  function positionNeighbours() {
    const i = store.activeIndex;
    for (const f of frames) {
      if (!f.ready) continue;
      const index = store.scenes.findIndex((s) => s.id === f.sceneId);
      if (index > i) seekFrame(f, 0);
      else if (index < i) seekFrame(f, store.scenes[index].duration - 0.0001);
    }
  }

  $effect(() => {
    const t = store.localTime;
    const frame = active;
    if (frame) untrack(() => seekFrame(frame, t));
  });

  $effect(() => {
    void store.activeIndex;
    untrack(positionNeighbours);
  });

  async function fixErrors(errors: string[]) {
    const scene = store.scenes[store.activeIndex];
    if (!store.project || !scene) return;
    store.panel = 'scene';
    store.sceneId = scene.id;
    await store.run(() =>
      api.send(store.project!.slug, scene.id, { text: `The scene throws this error in the preview. Please fix it:\n\n${errors.join('\n')}` }),
    );
  }
</script>

<div class="relative h-full w-full" bind:clientWidth={cw} bind:clientHeight={ch}>
  {#if scale}
    <div
      class="absolute overflow-hidden {dark ? '' : 'rounded-[3px] shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_3px_rgb(0_0_0/0.06)]'}"
      style="width:{W * scale}px;height:{H * scale}px;left:{(cw - W * scale) / 2}px;top:{(ch - H * scale) / 2}px;background:{dark ? '#000' : '#fff'}"
    >
      {#each frames as frame (frame.src)}
        <iframe
          bind:this={frame.el}
          src={frame.src}
          title={frame.sceneId}
          onload={() => onLoad(frame)}
          class="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
          style="width:{W}px;height:{H}px;transform:scale({scale});visibility:{frame === active ? 'visible' : 'hidden'}"
        ></iframe>
      {/each}
      {#if loading}
        <div class="absolute inset-0 grid place-items-center">
          <div class="size-5 animate-spin rounded-full border-2 border-line-strong border-t-fg"></div>
        </div>
      {/if}
      {#if !dark && active?.errors.length}
        <div class="absolute inset-x-3 bottom-3 flex items-start gap-3 rounded-lg bg-red-600/95 px-3.5 py-2.5 text-[13px] text-white shadow-lg">
          <div class="min-w-0 flex-1">
            <div class="font-semibold">Scene error</div>
            <div class="mt-0.5 line-clamp-3 font-mono text-[12px] opacity-90">{active.errors[0]}</div>
          </div>
          <button class="shrink-0 rounded-md bg-white/15 px-2.5 py-1 font-medium hover:bg-white/25" onclick={() => fixErrors(active!.errors)}>
            Ask Claude to fix
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
