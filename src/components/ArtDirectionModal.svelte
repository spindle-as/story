<script lang="ts">
  import { Sparkles } from '@lucide/svelte';
  import { api } from '../lib/api';
  import { store } from '../lib/store.svelte';
  import Modal from './Modal.svelte';

  type File = 'art-direction.md' | 'theme.css';
  let tab = $state<File>('art-direction.md');
  let content = $state<Record<File, string>>({ 'art-direction.md': '', 'theme.css': '' });
  let original = $state<Record<File, string>>({ 'art-direction.md': '', 'theme.css': '' });
  let saving = $state(false);
  const dirty = $derived(content['art-direction.md'] !== original['art-direction.md'] || content['theme.css'] !== original['theme.css']);

  $effect(() => {
    const slug = store.project!.slug;
    Promise.all([api.readFile(slug, 'art-direction.md'), api.readFile(slug, 'theme.css')]).then(([md, css]) => {
      content = { 'art-direction.md': md, 'theme.css': css };
      original = { ...content };
    });
  });

  async function save() {
    saving = true;
    for (const file of ['art-direction.md', 'theme.css'] as File[]) {
      if (content[file] !== original[file]) await store.run(() => api.writeFile(store.project!.slug, file, content[file]));
    }
    original = { ...content };
    saving = false;
    store.notify('Saved');
  }

  async function draft() {
    store.modal = null;
    store.panel = 'project';
    await store.run(() =>
      api.send(store.project!.slug, '_project', {
        text: "Study the codebase's design language (tokens, Tailwind config, CSS variables, fonts, components, brand assets, copy tone) and rewrite art-direction.md and theme.css so every scene looks like it belongs to this product. Copy the logo and any brand fonts into assets/. Don't change the scenes yet; summarise the direction you chose.",
      }),
    );
  }

  function close() {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    store.modal = null;
  }
</script>

<Modal title="Art direction" subtitle="Claude reads these before touching any scene. theme.css is linked into every scene." width={820} onclose={close}>
  <div class="mb-3 flex items-center gap-2">
    <div class="flex rounded-lg bg-raised p-0.5 text-[13px] font-medium">
      {#each ['art-direction.md', 'theme.css'] as file}
        <button
          class="rounded-md px-3 py-1 font-mono transition {tab === file ? 'bg-line text-fg shadow-sm' : 'text-muted hover:text-fg'}"
          onclick={() => (tab = file as File)}>{file}</button
        >
      {/each}
    </div>
    <div class="flex-1"></div>
    <button class="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium hover:bg-raised" onclick={draft}>
      <Sparkles size={14} />Draft from codebase
    </button>
  </div>
  <textarea
    class="block h-[52vh] w-full resize-none rounded-xl border border-line bg-ink/50 p-4 font-mono text-[13px] leading-relaxed outline-none focus:border-spindle/50 focus:bg-ink"
    spellcheck="false"
    bind:value={content[tab]}
  ></textarea>

  {#snippet footer()}
    <button class="rounded-lg px-3.5 py-2 text-[14px] font-medium text-fg-soft hover:bg-raised" onclick={close}>Close</button>
    <button class="rounded-lg bg-spindle px-4 py-2 text-[14px] font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40" disabled={!dirty || saving} onclick={save}
      >{saving ? 'Saving…' : 'Save'}</button
    >
  {/snippet}
</Modal>
