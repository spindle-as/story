<script lang="ts">
  import { Check, FolderOpen } from '@lucide/svelte';
  import { api } from '../lib/api';
  import { store } from '../lib/store.svelte';
  import Modal from './Modal.svelte';

  const FORMATS = [
    { label: '16:9', sub: '1920×1080', width: 1920, height: 1080 },
    { label: '1:1', sub: '1080×1080', width: 1080, height: 1080 },
    { label: '4:5', sub: '1080×1350', width: 1080, height: 1350 },
    { label: '9:16', sub: '1080×1920', width: 1080, height: 1920 },
  ];

  let name = $state('');
  let codebase = $state('');
  let url = $state('');
  let format = $state(0);
  let fps = $state(60);
  let brief = $state('');
  let busy = $state(false);
  let check = $state<{ ok: boolean; name?: string; markers?: string[] } | null>(null);
  let nameTouched = false;

  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const path = codebase.trim();
    clearTimeout(timer);
    if (!path) return void (check = null);
    timer = setTimeout(async () => {
      check = await api.checkFolder(path).catch(() => ({ ok: false }));
      if (check.ok && check.name && !nameTouched && !name) name = check.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }, 250);
  });

  async function browse() {
    const res = await store.run(() => api.pickFolder());
    if (res?.path) codebase = res.path;
  }

  async function create() {
    if (!codebase.trim() || busy) return;
    busy = true;
    const f = FORMATS[format];
    const res = await store.run(() =>
      api.createProject({ name: name.trim() || check?.name || 'Untitled', codebase: codebase.trim(), url, width: f.width, height: f.height, fps, brief }),
    );
    busy = false;
    if (!res) return;
    await store.refreshProjects();
    await store.openProject(res.slug);
    store.view = 'scenes';
    if (brief.trim()) store.panel = 'project';
    store.modal = null;
  }
</script>

<Modal title="New project" subtitle="A video about a codebase. Claude reads it (read-only) to rebuild the real UI." onclose={() => (store.modal = null)}>
  <div class="space-y-4 text-[14px]">
    <label class="block">
      <span class="field-label">Codebase</span>
      <div class="flex gap-2">
        <input class="field flex-1 font-mono text-[13px]" bind:value={codebase} placeholder="/Users/you/Code/my-app" />
        <button class="flex items-center gap-1.5 rounded-lg border border-line px-3 font-medium hover:bg-raised" onclick={browse}>
          <FolderOpen size={15} />Browse
        </button>
      </div>
      {#if check}
        <span class="mt-1.5 flex items-center gap-1.5 text-[12px] {check.ok ? 'text-emerald-300' : 'text-red-400'}">
          {#if check.ok}
            <Check size={13} />Found {check.name}{check.markers?.length ? ` · ${check.markers.join(', ')}` : ''}
          {:else}
            Folder not found
          {/if}
        </span>
      {/if}
    </label>

    <label class="block">
      <span class="field-label">Name</span>
      <input class="field w-full" bind:value={name} oninput={() => (nameTouched = true)} placeholder="Launch teaser" />
    </label>

    <label class="block">
      <span class="field-label">Running app URL <span class="font-normal text-faint">(optional, lets Claude screenshot it)</span></span>
      <input class="field w-full" bind:value={url} placeholder="http://localhost:3000" />
    </label>

    <div class="grid grid-cols-[1fr_auto] gap-4">
      <div>
        <span class="field-label">Format</span>
        <div class="grid grid-cols-4 gap-1.5">
          {#each FORMATS as f, i}
            <button
              class="rounded-lg border px-2 py-1.5 text-center transition {format === i ? 'border-fg bg-fg text-ink' : 'border-line hover:border-line-strong'}"
              onclick={() => (format = i)}
            >
              <div class="text-[13px] font-semibold">{f.label}</div>
              <div class="text-[11px] opacity-60">{f.sub}</div>
            </button>
          {/each}
        </div>
      </div>
      <div>
        <span class="field-label">FPS</span>
        <div class="flex gap-1.5">
          {#each [30, 60] as value}
            <button
              class="h-[46px] w-14 rounded-lg border text-[13px] font-semibold transition {fps === value ? 'border-fg bg-fg text-ink' : 'border-line hover:border-line-strong'}"
              onclick={() => (fps = value)}>{value}</button
            >
          {/each}
        </div>
      </div>
    </div>

    <label class="block">
      <span class="field-label">Brief <span class="font-normal text-faint">(optional, Claude plans and builds the first cut)</span></span>
      <textarea
        class="field w-full resize-none py-2 leading-relaxed"
        rows="4"
        bind:value={brief}
        placeholder="A 25-second launch teaser for our new Card component. Show its anatomy, every variant, light and dark, and end on the logo. Calm, precise, Apple-like."
      ></textarea>
    </label>
  </div>

  {#snippet footer()}
    <button class="rounded-lg px-3.5 py-2 text-[14px] font-medium text-fg-soft hover:bg-raised" onclick={() => (store.modal = null)}>Cancel</button>
    <button
      class="rounded-lg bg-spindle px-4 py-2 text-[14px] font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40"
      disabled={!codebase.trim() || check?.ok === false || busy}
      onclick={create}>{busy ? 'Creating…' : brief.trim() ? 'Create and start building' : 'Create project'}</button
    >
  {/snippet}
</Modal>

<style>
  @reference '../app.css';
  .field-label {
    @apply mb-1.5 block text-[13px] font-medium text-fg-soft;
  }
  .field {
    @apply h-10 rounded-lg border border-line px-3 outline-none transition focus:border-spindle/50 focus:ring-2 focus:ring-spindle/15;
  }
  textarea.field {
    @apply h-auto;
  }
</style>
