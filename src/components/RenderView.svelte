<script lang="ts">
  import { Download, Film, FolderSearch, X } from '@lucide/svelte';
  import type { RenderJob } from '../../shared/types';
  import { api } from '../lib/api';
  import { store } from '../lib/store.svelte';

  const project = $derived(store.project!);
  let scope = $state<'all' | 'scene'>('all');
  let scale = $state(1);
  let fps = $state(store.project?.fps ?? 60);
  let audio = $state(true);
  let starting = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  const scales = $derived(
    [0.5, 1, 1.5, 2].map((s) => ({ scale: s, w: Math.round(project.width * s), h: Math.round(project.height * s) })),
  );
  const seconds = $derived(scope === 'all' ? store.total : (store.scene?.duration ?? 0));
  const frames = $derived(Math.round(seconds * fps));
  const active = $derived(store.renders.filter((r) => r.status === 'rendering' || r.status === 'encoding'));
  const finished = $derived(store.renders.filter((r) => r.status !== 'rendering' && r.status !== 'encoding'));

  async function start() {
    starting = true;
    await store.run(() =>
      api.render(project.slug, { scope: scope === 'all' ? 'all' : store.scene!.id, scale, fps, audio: audio && !!project.audio }),
    );
    starting = false;
  }

  function eta(job: RenderJob) {
    if (!job.frames) return 'starting…';
    const elapsed = (now - job.startedAt) / 1000;
    const left = (elapsed / job.frames) * (job.totalFrames - job.frames);
    return left < 60 ? `${Math.ceil(left)}s left` : `${Math.ceil(left / 60)} min left`;
  }

  const mb = (bytes = 0) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const when = (ts: number) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
</script>

<div class="scrollbar-thin h-full overflow-y-auto bg-raised">
  <div class="mx-auto grid max-w-6xl grid-cols-[360px_1fr] gap-8 px-8 py-8">
    <section class="h-fit rounded-2xl border border-line bg-panel p-5 shadow-xs">
      <h2 class="text-[16px] font-semibold tracking-tight">Export video</h2>
      <p class="mt-1 text-[13px] text-muted">Every frame is rendered in headless Chromium and encoded to H.264 with ffmpeg, so the export matches the preview exactly.</p>

      <div class="mt-5 space-y-4 text-[13px]">
        <div>
          <span class="label">What</span>
          <div class="grid grid-cols-2 gap-1.5">
            <button class="opt {scope === 'all' ? 'on' : ''}" onclick={() => (scope = 'all')}>Whole video<small>{store.scenes.length} scenes</small></button>
            <button class="opt {scope === 'scene' ? 'on' : ''}" onclick={() => (scope = 'scene')} disabled={!store.scene}
              >This scene<small class="truncate">{store.scene?.title}</small></button
            >
          </div>
        </div>
        <div>
          <span class="label">Resolution</span>
          <div class="grid grid-cols-4 gap-1.5">
            {#each scales as s}
              <button class="opt {scale === s.scale ? 'on' : ''}" onclick={() => (scale = s.scale)}>{s.h}p<small>{s.w}×{s.h}</small></button>
            {/each}
          </div>
        </div>
        <div>
          <span class="label">Frame rate</span>
          <div class="grid grid-cols-4 gap-1.5">
            {#each [24, 30, 50, 60] as v}
              <button class="opt {fps === v ? 'on' : ''}" onclick={() => (fps = v)}>{v}</button>
            {/each}
          </div>
        </div>
        {#if project.audio}
          <label class="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 {scope !== 'all' ? 'opacity-50' : ''}">
            <input type="checkbox" bind:checked={audio} disabled={scope !== 'all'} class="size-4 accent-spindle" />
            <span class="min-w-0 flex-1 truncate">Include music <span class="text-faint">· {project.audio.name}</span></span>
          </label>
        {/if}
      </div>

      <div class="mt-5 flex items-center justify-between border-t border-line/60 pt-4 text-[13px] text-muted">
        <span>{seconds.toFixed(2)}s · {frames.toLocaleString()} frames</span>
        <button
          class="flex items-center gap-2 rounded-lg bg-spindle px-4 py-2 text-[14px] font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40"
          disabled={starting || !store.scenes.length}
          onclick={start}><Film size={15} />Render MP4</button
        >
      </div>
    </section>

    <section class="min-w-0 space-y-4">
      {#each active as job (job.id)}
        <div class="rounded-2xl border border-line bg-panel p-5 shadow-xs">
          <div class="flex items-center gap-3">
            <span class="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-fg"></span>
            <div class="flex-1 text-[14px] font-medium">
              {job.status === 'encoding' ? 'Encoding…' : `Rendering ${job.frames.toLocaleString()} / ${job.totalFrames.toLocaleString()} frames`}
            </div>
            <span class="text-[13px] text-muted">{job.status === 'rendering' ? eta(job) : ''}</span>
            <button class="grid size-7 place-items-center rounded-md text-faint hover:bg-raised hover:text-fg" title="Cancel" onclick={() => api.cancelRender(job.id)}
              ><X size={15} /></button
            >
          </div>
          <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-raised">
            <div class="h-full rounded-full bg-spindle transition-[width] duration-300" style="width:{(job.frames / job.totalFrames) * 100}%"></div>
          </div>
          <div class="mt-2 text-[12px] text-faint">{job.width}×{job.height} · {job.settings.fps} fps · {job.duration.toFixed(2)}s</div>
        </div>
      {/each}

      {#each finished as job (job.id)}
        <div class="overflow-hidden rounded-2xl border border-line bg-panel shadow-xs">
          {#if job.status === 'done' && job.url}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={job.url} controls preload="metadata" class="aspect-video w-full bg-black"></video>
          {/if}
          <div class="flex items-center gap-3 px-5 py-3.5">
            <div class="min-w-0 flex-1">
              <div class="truncate text-[14px] font-medium">
                {#if job.status === 'done'}{job.file?.split('/').at(-1)}{:else if job.status === 'cancelled'}Cancelled{:else}Render failed{/if}
              </div>
              <div class="text-[12px] text-muted">
                {when(job.startedAt)} · {job.width}×{job.height} · {job.settings.fps} fps · {job.duration.toFixed(2)}s
                {#if job.size}· {mb(job.size)}{/if}
                {#if job.finishedAt}· took {Math.round((job.finishedAt - job.startedAt) / 1000)}s{/if}
              </div>
              {#if job.error}<div class="mt-1 font-mono text-[12px] break-words text-red-400">{job.error}</div>{/if}
            </div>
            {#if job.status === 'done' && job.file}
              <button class="act" onclick={() => api.reveal(job.file!)}><FolderSearch size={15} />Show in Finder</button>
              <a class="act" href={job.url} download><Download size={15} />Download</a>
              {#if job.captionsUrl}<a class="act" href={job.captionsUrl} download>Captions</a>{/if}
            {/if}
          </div>
        </div>
      {:else}
        {#if !active.length}
          <div class="grid h-64 place-items-center rounded-2xl border border-dashed border-line-strong text-[14px] text-faint">
            Renders appear here.
          </div>
        {/if}
      {/each}
    </section>
  </div>
</div>

<style>
  @reference '../app.css';
  .label {
    @apply mb-1.5 block font-medium text-fg-soft;
  }
  .opt {
    @apply flex min-w-0 flex-col items-center rounded-lg border border-line px-2 py-1.5 font-semibold transition hover:border-line-strong disabled:opacity-40;
  }
  .opt small {
    @apply max-w-full text-[11px] font-normal opacity-60;
  }
  .opt.on {
    @apply border-fg bg-fg text-ink;
  }
  .act {
    @apply flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium hover:bg-raised;
  }
</style>
