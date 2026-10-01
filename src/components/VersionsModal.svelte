<script lang="ts">
  import type { Version } from '../../shared/types';
  import { api } from '../lib/api';
  import { store } from '../lib/store.svelte';
  import Modal from './Modal.svelte';

  let versions = $state<Version[]>([]);
  let current = $state(-1);
  let selected = $state<Version | null>(null);
  let previewWidth = $state(0);

  const scene = store.scene!;
  const slug = store.project!.slug;
  const W = store.project!.width;
  const H = store.project!.height;

  async function load() {
    const res = await api.versions(slug, scene.id);
    versions = res.versions.slice().reverse();
    current = res.versions.length - 1 - res.current;
    selected ??= versions[current >= 0 ? current : 0] ?? null;
  }
  load();

  async function restore(v: Version) {
    await store.run(() => api.restore(slug, scene.id, v.id));
    await load();
    store.notify('Version restored');
  }

  const fmt = (ts: number) => {
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  };
</script>

<Modal title="Versions of “{scene.title}”" subtitle="Every change to the scene file is kept. Restoring is itself undoable." width={1040} onclose={() => (store.modal = null)}>
  <div class="grid grid-cols-[300px_1fr] gap-5">
    <ol class="scrollbar-thin max-h-[56vh] space-y-1 overflow-y-auto pr-1">
      {#each versions as v, i (v.id)}
        <li>
          <button
            class="w-full rounded-lg px-3 py-2 text-left transition {selected?.id === v.id ? 'bg-fg text-ink' : 'hover:bg-raised'}"
            onclick={() => (selected = v)}
          >
            <div class="flex items-center gap-2 text-[12px] {selected?.id === v.id ? 'text-ink/60' : 'text-muted'}">
              <span class="tabular">{fmt(v.ts)}</span>
              <span>· {v.duration}s</span>
              {#if i === current}<span class="ml-auto rounded bg-spindle px-1.5 font-mono text-[10px] font-medium text-ink uppercase">Current</span>{/if}
            </div>
            <div class="mt-0.5 line-clamp-2 text-[13px] font-medium">{v.label}</div>
          </button>
        </li>
      {/each}
    </ol>
    <div>
      {#if selected}
        <div bind:clientWidth={previewWidth} class="relative overflow-hidden rounded-lg bg-panel ring-1 ring-line" style="aspect-ratio:{W}/{H}">
          {#key selected.id}
            <iframe
              title="Version preview"
              src="{scene.url}?embed=1&play=1&w={W}&h={H}&version={selected.id}"
              class="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
              style="width:{W}px;height:{H}px;transform:scale({previewWidth / W})"
            ></iframe>
          {/key}
        </div>
        <div class="mt-3 flex items-center gap-3">
          <p class="flex-1 text-[13px] text-muted">Plays on a loop. {selected.label}</p>
          <button
            class="rounded-lg bg-spindle px-4 py-2 text-[14px] font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40"
            disabled={versions.indexOf(selected) === current}
            onclick={() => restore(selected!)}>Restore this version</button
          >
        </div>
      {/if}
    </div>
  </div>
</Modal>
