<script lang="ts">
  import { Copy, ExternalLink, History, Music, Palette, Settings2, Trash2, Undo2 } from '@lucide/svelte';
  import { api } from '../lib/api';
  import { fmtTime, store } from '../lib/store.svelte';
  import Composer from './Composer.svelte';
  import Message from './Message.svelte';
  import SoundPanel from './SoundPanel.svelte';
  import VoicePanel from './VoicePanel.svelte';

  const scope = $derived(store.panel === 'project' ? '_project' : store.panel === 'scene' ? (store.scene?.id ?? null) : null);
  const chat = $derived(scope ? store.chats[scope] : undefined);
  const running = $derived(chat?.messages.some((m) => m.status === 'running') ?? false);

  let scroller = $state<HTMLDivElement>();
  let title = $state('');
  let stickToBottom = true;

  $effect(() => {
    if (scope && store.project && !store.chats[scope]) store.loadChat(scope);
  });

  $effect(() => {
    title = store.panel === 'project' ? (store.project?.name ?? '') : (store.scene?.title ?? '');
  });

  // Keep the newest message in view while it streams, unless the user scrolled up.
  $effect(() => {
    const last = chat?.messages.at(-1);
    void last?.text;
    void last?.activity?.length;
    void chat?.messages.length;
    if (scroller && stickToBottom) requestAnimationFrame(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
  });

  $effect(() => {
    void scope;
    stickToBottom = true;
  });

  function onScroll() {
    if (!scroller) return;
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  }

  async function saveTitle() {
    const value = title.trim();
    if (!store.project || !value) return;
    if (store.panel === 'project') {
      if (value !== store.project.name) await store.run(() => api.updateProject(store.project!.slug, { name: value }));
      store.refreshProjects();
    } else if (store.scene && value !== store.scene.title) {
      await store.run(() => api.updateScene(store.project!.slug, store.scene!.id, { title: value }));
    }
    await store.refreshProject();
  }

  async function undo() {
    if (!store.project || !store.scene) return;
    const res = await store.run(() => api.undo(store.project!.slug, store.scene!.id));
    if (res) store.notify(res.ok ? 'Went back one version' : 'Nothing to undo');
  }

  async function duplicate() {
    if (!store.project || !store.scene) return;
    const res = await store.run(() => api.duplicateScene(store.project!.slug, store.scene!.id));
    if (!res) return;
    await store.refreshProject();
    store.selectScene(res.id);
  }

  async function remove() {
    if (!store.project || !store.scene) return;
    if (!confirm(`Delete “${store.scene.title}”? The file is kept in .story/trash.`)) return;
    await store.run(() => api.deleteScene(store.project!.slug, store.scene!.id));
    await store.refreshProject();
  }

  async function clear() {
    if (!store.project || !scope) return;
    if (!confirm('Clear this conversation? Claude starts fresh, the scene stays as it is.')) return;
    await store.run(() => api.clearChat(store.project!.slug, scope!));
    store.chats[scope] = { scope, messages: [] };
  }

  const suggestions = $derived(
    store.panel === 'project'
      ? [
          'Plan a 30-second teaser from the codebase and build every scene',
          'Draft art direction and theme.css from the real design system',
          'Make every cut between scenes invisible',
        ]
      : [
          'Rebuild this scene from the real UI in the codebase',
          'Hold the final composition half a second longer',
          'Make the entrance feel more premium: blur in, stagger the parts',
        ],
  );
</script>

<aside class="flex h-full min-h-0 flex-col border-l border-line bg-panel">
  <header class="flex h-[62px] shrink-0 items-center gap-3 border-b border-line px-4">
    <div class="flex shrink-0 rounded-lg bg-raised p-0.5 text-[13px] font-medium">
      {#each [['scene', 'Scene'], ['project', 'Project'], ['sound', 'Sound'], ['voice', 'Voice']] as [value, label]}
        <button
          class="rounded-md px-3 py-1 transition {store.panel === value ? 'bg-line text-fg shadow-sm' : 'text-muted hover:text-fg'}"
          onclick={() => (store.panel = value as 'scene' | 'project' | 'sound' | 'voice')}>{label}</button
        >
      {/each}
    </div>
    <input
      class="min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 py-1 text-[17px] font-semibold tracking-tight outline-none hover:bg-raised focus:bg-raised focus:ring-1 focus:ring-line"
      bind:value={title}
      onblur={saveTitle}
      onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      aria-label="Title"
    />
    <span class="tabular shrink-0 font-mono text-[13px] text-muted"
      >{fmtTime(store.panel === 'project' ? store.total : (store.scene?.duration ?? 0))}s</span
    >
  </header>

  {#if store.panel === 'sound'}
    <SoundPanel />
  {:else if store.panel === 'voice'}
    <VoicePanel />
  {:else}
  <div class="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-line px-4 text-[13px]">
    {#if store.panel === 'scene'}
      <button class="btn" onclick={undo} disabled={!store.scene}><Undo2 size={15} />Undo</button>
      <button class="btn" onclick={() => (store.modal = 'versions')} disabled={!store.scene}>
        <History size={15} />Versions ({store.scene?.versions ?? 0})
      </button>
      <button class="icon-btn" title="Open scene in a new tab" onclick={() => store.scene && window.open(store.scene.url, '_blank')}>
        <ExternalLink size={15} />
      </button>
      <button class="icon-btn" title="Duplicate scene" onclick={duplicate}><Copy size={15} /></button>
      <button class="icon-btn danger" title="Delete scene" onclick={remove}><Trash2 size={15} /></button>
    {:else}
      <button class="btn" onclick={() => (store.modal = 'art-direction')}><Palette size={15} />Art direction</button>
      <button class="btn" onclick={() => (store.modal = 'soundtrack')}><Music size={15} />Soundtrack</button>
      <button class="btn" onclick={() => (store.modal = 'settings')}><Settings2 size={15} />Settings</button>
    {/if}
    <button class="ml-auto rounded-md px-2 py-1 font-medium text-fg-soft hover:bg-raised hover:text-fg disabled:opacity-40" onclick={clear} disabled={!chat?.messages.length || running}>
      Clear chat
    </button>
  </div>

  <div bind:this={scroller} onscroll={onScroll} class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
    {#if chat && chat.messages.length}
      <div class="flex flex-col gap-4">
        {#each chat.messages as message (message.id)}
          <Message {message} />
        {/each}
      </div>
    {:else if chat}
      <div class="flex h-full flex-col justify-end gap-2 pb-2">
        <p class="mb-2 text-[13px] leading-relaxed text-muted">
          {#if store.panel === 'project'}
            Talk to Claude about the whole video. It can plan scenes, add and reorder them, and keep the style consistent. It reads <span class="font-medium text-fg-soft">{store.project?.codebase.split('/').at(-1)}</span> to rebuild your real UI.
          {:else}
            Describe what this scene should show or how it should move. Claude edits the scene, renders frames to check its work, and the preview updates live. Your playhead position is sent along.
          {/if}
        </p>
        {#each suggestions as suggestion}
          <button
            class="rounded-lg border border-line px-3 py-2 text-left text-[13px] text-fg-soft transition hover:border-line-strong hover:bg-raised"
            onclick={() => document.dispatchEvent(new CustomEvent('story:suggest', { detail: suggestion }))}>{suggestion}</button
          >
        {/each}
      </div>
    {/if}
  </div>

  {#if scope}
    <Composer {scope} {running} />
  {/if}
  {/if}
</aside>

<style>
  @reference '../app.css';
  .btn {
    @apply flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-medium text-fg shadow-xs transition hover:bg-raised disabled:opacity-40;
  }
  .icon-btn {
    @apply grid size-7 place-items-center rounded-md text-fg-soft transition hover:bg-raised hover:text-fg;
  }
  .icon-btn.danger {
    @apply text-red-400 hover:text-red-400;
  }
</style>
