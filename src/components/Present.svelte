<script lang="ts">
  import { onMount } from 'svelte';
  import { fmtTime, store } from '../lib/store.svelte';
  import Stage from './Stage.svelte';

  let root = $state<HTMLDivElement>();
  let idle = $state(false);
  let timer: ReturnType<typeof setTimeout>;

  onMount(() => {
    const previousMode = store.mode;
    store.setMode('whole');
    store.seek(0);
    store.play();
    root?.requestFullscreen?.().catch(() => {});
    const onFullscreen = () => !document.fullscreenElement && exit();
    document.addEventListener('fullscreenchange', onFullscreen);
    wake();
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      store.pause();
      store.setMode(previousMode);
    };
  });

  function exit() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    store.presenting = false;
  }

  function wake() {
    idle = false;
    clearTimeout(timer);
    timer = setTimeout(() => (idle = true), 1800);
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') exit();
  }
</script>

<svelte:window onkeydown={keydown} />

<div
  bind:this={root}
  class="fixed inset-0 z-[60] bg-black {idle ? 'cursor-none' : ''}"
  role="presentation"
  onmousemove={wake}
  onclick={() => store.toggle()}
>
  <Stage dark />
  <div class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-8 pt-16 pb-6 text-white transition-opacity duration-500 {idle ? 'opacity-0' : 'opacity-100'}">
    <div class="flex items-center gap-4 text-[13px]">
      <span class="font-medium">{store.scenes[store.activeIndex]?.title}</span>
      <span class="tabular font-mono opacity-60">{fmtTime(store.time)} / {fmtTime(store.total)}s</span>
      <span class="ml-auto opacity-60">Click to pause · Esc to exit</span>
    </div>
    <div class="mt-3 h-[3px] rounded-full bg-white/20">
      <div class="h-full rounded-full bg-white" style="width:{(store.time / store.total) * 100}%"></div>
    </div>
  </div>
</div>
