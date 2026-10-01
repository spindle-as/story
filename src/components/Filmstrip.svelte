<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { api } from '../lib/api';
  import { fmtTime, store } from '../lib/store.svelte';

  let dragId = $state<string | null>(null);
  let overId = $state<string | null>(null);
  let strip = $state<HTMLDivElement>();
  /** Failed thumbnail loads per scene version; retried a few times since a scene may be mid-edit. */
  let attempts = $state<Record<string, number>>({});

  function thumb(id: string, version: number) {
    const key = `${id}-${store.reloadKeys[id] ?? version}-${store.assetsKey}`;
    return `/api/projects/${store.project!.slug}/scenes/${id}/thumb?v=${key}${attempts[key] ? `&retry=${attempts[key]}` : ''}`;
  }

  function failed(id: string, version: number) {
    return (attempts[`${id}-${store.reloadKeys[id] ?? version}-${store.assetsKey}`] ?? 0) > 3;
  }

  function retry(id: string, version: number) {
    const key = `${id}-${store.reloadKeys[id] ?? version}-${store.assetsKey}`;
    setTimeout(() => (attempts[key] = (attempts[key] ?? 0) + 1), 1500);
  }

  async function drop(targetId: string) {
    if (!dragId || dragId === targetId || !store.project) return;
    const ids = store.scenes.map((s) => s.id).filter((id) => id !== dragId);
    const to = store.scenes.findIndex((s) => s.id === targetId);
    const from = store.scenes.findIndex((s) => s.id === dragId);
    ids.splice(ids.indexOf(targetId) + (from < to ? 1 : 0), 0, dragId);
    dragId = overId = null;
    await store.run(() => api.reorder(store.project!.slug, ids));
    await store.refreshProject();
  }

  async function add() {
    if (!store.project) return;
    const res = await store.run(() => api.createScene(store.project!.slug, 'New scene', store.scene?.id));
    if (!res) return;
    await store.refreshProject();
    store.selectScene(res.id);
    store.panel = 'scene';
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#composer')?.focus());
  }

  $effect(() => {
    const id = store.scene?.id;
    if (!id || !strip) return;
    strip.querySelector(`[data-scene="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });
</script>

<div bind:this={strip} class="scrollbar-thin flex h-full items-start gap-3 overflow-x-auto px-5 pt-3 pb-2">
  {#each store.scenes as scene, i (scene.id)}
    {@const active = scene.id === store.scene?.id}
    <button
      data-scene={scene.id}
      draggable="true"
      ondragstart={(e) => {
        dragId = scene.id;
        e.dataTransfer!.effectAllowed = 'move';
      }}
      ondragover={(e) => {
        e.preventDefault();
        overId = scene.id;
      }}
      ondragleave={() => overId === scene.id && (overId = null)}
      ondrop={() => drop(scene.id)}
      ondragend={() => (dragId = overId = null)}
      onclick={() => store.selectScene(scene.id)}
      class="group w-[220px] shrink-0 text-left transition {dragId === scene.id ? 'opacity-40' : ''}"
    >
      <div
        class="relative aspect-video overflow-hidden rounded-lg bg-raised transition
          {active ? 'ring-2 ring-spindle ring-offset-2 ring-offset-panel' : 'ring-1 ring-line group-hover:ring-line-strong'}
          {overId === scene.id && dragId !== scene.id ? 'ring-2 ring-fg' : ''}"
      >
        {#if !failed(scene.id, scene.version)}
          <img
            src={thumb(scene.id, scene.version)}
            alt=""
            class="absolute inset-0 h-full w-full object-cover"
            onerror={() => retry(scene.id, scene.version)}
          />
        {:else}
          <div class="absolute inset-0 grid place-items-center text-[11px] text-red-400">Preview failed</div>
        {/if}
        <span class="absolute top-1.5 left-1.5 grid h-5 min-w-5 place-items-center rounded bg-ink/85 px-1 font-mono text-[11px] font-medium text-fg"
          >{i + 1}</span
        >
        {#if scene.busy}
          <span class="absolute top-1.5 right-1.5 flex items-center gap-1.5 rounded-full bg-panel/95 px-2 py-0.5 text-[11px] font-medium shadow-sm">
            <span class="size-2.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-fg"></span>
            Working
          </span>
        {/if}
      </div>
      <div class="mt-1.5 flex items-baseline gap-1.5 px-0.5 text-[13px]">
        <span class="truncate font-medium text-fg">{scene.title}</span>
        <span class="tabular shrink-0 text-faint">{fmtTime(scene.duration)}s</span>
      </div>
    </button>
  {/each}
  <button
    onclick={add}
    class="grid aspect-video w-[120px] shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-faint transition hover:border-faint hover:bg-raised hover:text-fg-soft"
    title="Add a scene after the current one"
  >
    <span class="flex flex-col items-center gap-1 text-[12px] font-medium"><Plus size={18} />Add scene</span>
  </button>
</div>
