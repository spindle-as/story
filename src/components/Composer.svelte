<script lang="ts">
  import { ImagePlus, Square, X } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { api } from '../lib/api';
  import { store } from '../lib/store.svelte';

  let { scope, running }: { scope: string; running: boolean } = $props();

  let text = $state('');
  let attachments = $state<{ path: string; url: string }[]>([]);
  let uploading = $state(0);
  let sending = $state(false);
  let dragging = $state(false);
  let textarea = $state<HTMLTextAreaElement>();
  let fileInput = $state<HTMLInputElement>();

  // Drafts survive switching scenes.
  const drafts: Record<string, string> = {};
  let previous = untrack(() => scope);
  $effect(() => {
    if (scope === previous) return;
    drafts[previous] = text;
    text = drafts[scope] ?? '';
    attachments = [];
    previous = scope;
  });

  $effect(() => {
    const onSuggest = (e: Event) => {
      text = (e as CustomEvent<string>).detail;
      textarea?.focus();
    };
    document.addEventListener('story:suggest', onSuggest);
    return () => document.removeEventListener('story:suggest', onSuggest);
  });

  $effect(() => {
    void text;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  });

  async function addFiles(files: Iterable<File>) {
    if (!store.project) return;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      uploading++;
      const res = await store.run(() => api.upload(store.project!.slug, file));
      uploading--;
      if (res) attachments.push(res);
    }
  }

  async function send() {
    const value = text.trim();
    if (!value || !store.project || running || sending || uploading) return;
    sending = true;
    const playhead = store.panel === 'scene' ? store.localTime : store.mode === 'whole' ? store.time : undefined;
    const res = await store.run(() =>
      api.send(store.project!.slug, scope, {
        text: value,
        playhead: playhead === undefined ? undefined : Number(playhead.toFixed(3)),
        attachments: attachments.map((a) => a.path),
      }),
    );
    sending = false;
    if (res) {
      text = '';
      attachments = [];
      drafts[scope] = '';
    }
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="shrink-0 border-t border-line p-4">
  <div
    role="group"
    class="rounded-xl border bg-panel transition {dragging ? 'border-spindle/60 ring-2 ring-spindle/15' : 'border-line focus-within:border-line-strong focus-within:shadow-sm'}"
    ondragover={(e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        dragging = true;
      }
    }}
    ondragleave={() => (dragging = false)}
    ondrop={(e) => {
      e.preventDefault();
      dragging = false;
      addFiles(e.dataTransfer?.files ?? []);
    }}
  >
    {#if attachments.length || uploading}
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        {#each attachments as a, i}
          <div class="group relative">
            <img src={a.url} alt="" class="h-14 rounded-md object-cover ring-1 ring-line" />
            <button
              class="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-fg text-ink opacity-0 transition group-hover:opacity-100"
              onclick={() => attachments.splice(i, 1)}
              title="Remove"><X size={12} /></button
            >
          </div>
        {/each}
        {#if uploading}
          <div class="grid h-14 w-20 place-items-center rounded-md bg-raised">
            <span class="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-fg"></span>
          </div>
        {/if}
      </div>
    {/if}
    <textarea
      id="composer"
      bind:this={textarea}
      bind:value={text}
      onkeydown={keydown}
      onpaste={(e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
      rows="2"
      placeholder={store.panel === 'project'
        ? 'What should the video be? e.g. "A 30s teaser for the new table component, ending on the logo."'
        : 'What should change? e.g. "Hold on the headline a full second longer, then slide the card in from the right."'}
      class="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
    ></textarea>
    <div class="flex items-center gap-2 px-3 pb-2.5">
      <button
        class="grid size-7 place-items-center rounded-md text-faint transition hover:bg-raised hover:text-fg"
        title="Attach reference images (or paste / drop them)"
        onclick={() => fileInput?.click()}><ImagePlus size={16} /></button
      >
      <input bind:this={fileInput} type="file" accept="image/*" multiple class="hidden" onchange={(e) => addFiles((e.currentTarget as HTMLInputElement).files ?? [])} />
      <span class="text-[12px] text-faint">⌘↵ to send</span>
      <div class="flex-1"></div>
      {#if running}
        <button
          class="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] font-semibold text-fg transition hover:bg-line"
          onclick={() => store.project && api.stop(store.project.slug, scope)}><Square size={11} fill="currentColor" />Stop</button
        >
      {:else}
        <button
          class="rounded-lg bg-spindle px-4 py-1.5 text-[13px] font-semibold text-ink transition hover:bg-spindle-hover disabled:opacity-30"
          disabled={!text.trim() || sending || uploading > 0}
          onclick={send}>Send</button
        >
      {/if}
    </div>
  </div>
</div>
