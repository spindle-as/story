<script lang="ts">
  import { ChevronDown, Copy, Maximize, Palette, Plus } from '@lucide/svelte';
  import icon from '../assets/brand/spindle-icon.svg';
  import { store } from '../lib/store.svelte';
  import Wordmark from './Wordmark.svelte';

  async function copyPath() {
    const path = store.panel === 'scene' && store.scene ? store.scene.file : store.project?.dir;
    if (!path) return;
    await navigator.clipboard.writeText(path);
    store.notify(`Copied ${path.split('/').slice(-2).join('/')}`);
  }

  function present() {
    store.presenting = true;
  }
</script>

<header class="flex h-[60px] shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
  <div class="flex items-center gap-2.5 pr-3">
    <img src={icon} alt="" class="size-8 rounded-[9px] ring-1 ring-line" />
    <Wordmark size={19} />
  </div>

  <label class="relative">
    <select
      class="h-9 max-w-[280px] appearance-none truncate rounded-lg border border-line bg-panel pr-9 pl-3 text-[14px] font-medium shadow-xs outline-none hover:border-line-strong focus:ring-2 focus:ring-line"
      value={store.project?.slug ?? ''}
      onchange={(e) => store.openProject((e.currentTarget as HTMLSelectElement).value)}
    >
      {#if !store.project}<option value="">No project</option>{/if}
      {#each store.projects as p}
        <option value={p.slug}>{p.name}</option>
      {/each}
    </select>
    <ChevronDown size={15} class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
  </label>

  <button class="tb-btn" onclick={() => (store.modal = 'new-project')}><Plus size={15} />New project</button>

  {#if store.project}
    <div class="ml-2 flex rounded-lg bg-raised p-0.5 text-[14px] font-medium">
      {#each [['scenes', 'Scenes'], ['render', 'Render']] as [value, label]}
        <button
          class="rounded-md px-3.5 py-1 transition {store.view === value ? 'bg-line text-fg shadow-sm' : 'text-muted hover:text-fg'}"
          onclick={() => (store.view = value as 'scenes' | 'render')}>{label}</button
        >
      {/each}
    </div>

    <div class="flex-1"></div>

    <button class="tb-btn" onclick={() => (store.modal = 'art-direction')}><Palette size={15} />Art direction</button>
    <button class="tb-btn" onclick={copyPath} title="Copy the path of the current scene file (or the project folder)"><Copy size={15} />Copy path</button>
    <button
      class="flex h-9 items-center gap-2 rounded-lg bg-spindle px-3.5 text-[14px] font-semibold text-ink transition hover:bg-spindle-hover"
      onclick={present}><Maximize size={15} />Present</button
    >
  {/if}
</header>

<style>
  @reference '../app.css';
  .tb-btn {
    @apply flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-[14px] font-medium text-fg shadow-xs transition hover:border-line-strong hover:bg-raised;
  }
</style>
