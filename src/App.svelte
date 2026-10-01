<script lang="ts">
  import { onMount } from 'svelte';
  import ArtDirectionModal from './components/ArtDirectionModal.svelte';
  import ChatPanel from './components/ChatPanel.svelte';
  import Filmstrip from './components/Filmstrip.svelte';
  import NewProjectModal from './components/NewProjectModal.svelte';
  import Present from './components/Present.svelte';
  import RenderView from './components/RenderView.svelte';
  import SettingsModal from './components/SettingsModal.svelte';
  import SoundtrackModal from './components/SoundtrackModal.svelte';
  import Stage from './components/Stage.svelte';
  import TopBar from './components/TopBar.svelte';
  import Transport from './components/Transport.svelte';
  import VersionsModal from './components/VersionsModal.svelte';
  import Wordmark from './components/Wordmark.svelte';
  import { store } from './lib/store.svelte';

  onMount(() => {
    store.init().catch((e) => store.notify(e.message, 'error'));
  });

  function keydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (store.modal || store.presenting || target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const fps = store.project?.fps ?? 60;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        store.toggle();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        store.step(e.shiftKey ? -fps : -1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        store.step(e.shiftKey ? fps : 1);
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const next = store.scenes[store.sceneIndex + (e.key === 'ArrowUp' ? -1 : 1)];
        if (next) store.selectScene(next.id);
        break;
      }
      case 'Home':
        store.seek(0);
        break;
      case 'End':
        store.seek(store.duration);
        break;
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="flex h-full flex-col">
  <TopBar />

  {#if store.project && store.view === 'render'}
    <div class="min-h-0 flex-1"><RenderView /></div>
  {:else if store.project}
    <div class="flex min-h-0 flex-1">
      <main class="flex min-w-0 flex-1 flex-col bg-ink">
        <div class="flex h-9 shrink-0 items-end gap-1.5 px-7 text-[14px]">
          {#if store.scene}
            {@const active = store.scenes[store.activeIndex] ?? store.scene}
            <span class="font-semibold">Scene {store.activeIndex + 1} of {store.scenes.length}</span>
            <span class="text-muted">· {active.title}</span>
            {#each active.tags as tag}<span class="text-faint">· {tag}</span>{/each}
          {/if}
        </div>
        <div class="min-h-0 flex-1 px-6 py-3">
          {#if store.scenes.length}
            <Stage />
          {:else}
            <div class="grid h-full place-items-center text-[14px] text-faint">No scenes yet. Ask Claude in the Project chat, or add one below.</div>
          {/if}
        </div>
        <Transport />
      </main>
      <div class="w-[clamp(380px,30vw,500px)] shrink-0">
        <ChatPanel />
      </div>
    </div>
    <div class="h-[168px] shrink-0 border-t border-line bg-panel">
      <Filmstrip />
    </div>
  {:else if store.loaded}
    <div class="grid flex-1 place-items-center bg-ink">
      <div class="flex max-w-md flex-col items-center text-center">
        <Wordmark size={44} signed />
        <h1 class="mt-10 text-[28px] font-semibold tracking-tight">Make a video about your code</h1>
        <p class="mt-2 text-[15px] leading-relaxed text-muted">
          Point spindle/story at a codebase. Claude reads it, rebuilds the real UI as animated scenes, and you direct every moment with prompts.
        </p>
        <button class="mt-6 rounded-lg bg-spindle px-5 py-2.5 text-[14px] font-semibold text-ink hover:bg-spindle-hover" onclick={() => (store.modal = 'new-project')}>
          New project
        </button>
      </div>
    </div>
  {/if}
</div>

{#if store.modal === 'new-project'}<NewProjectModal />{/if}
{#if store.modal === 'art-direction' && store.project}<ArtDirectionModal />{/if}
{#if store.modal === 'versions' && store.scene}<VersionsModal />{/if}
{#if store.modal === 'settings' && store.project}<SettingsModal />{/if}
{#if store.modal === 'soundtrack' && store.project}<SoundtrackModal />{/if}
{#if store.presenting && store.project}<Present />{/if}

{#if store.toast}
  <div
    class="fixed bottom-6 left-1/2 z-[70] max-w-lg -translate-x-1/2 rounded-xl px-4 py-2.5 text-[13.5px] font-medium shadow-lg {store.toast.kind === 'error'
      ? 'bg-red-600 text-white'
      : 'bg-raised text-fg ring-1 ring-line'}"
  >
    {store.toast.text}
  </div>
{/if}
