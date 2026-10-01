<script lang="ts">
  import { Music, Trash2, Upload } from '@lucide/svelte';
  import { api } from '../lib/api';
  import { analyzeBeats } from '../lib/beats';
  import { store } from '../lib/store.svelte';
  import Modal from './Modal.svelte';

  const project = store.project!;
  let name = $state(project.name);
  let codebase = $state(project.codebase);
  let url = $state(project.url ?? '');
  let fps = $state(project.fps);
  let model = $state(project.model ?? '');
  let offset = $state(project.audio?.offset ?? 0);
  let analyzing = $state(false);
  let dragging = $state(false);
  let fileInput = $state<HTMLInputElement>();

  const audio = $derived(store.project?.audio ?? null);

  async function save() {
    const res = await store.run(() =>
      api.updateProject(project.slug, {
        name: name.trim() || project.name,
        codebase: codebase.trim(),
        url: url.trim() || undefined,
        fps: Number(fps) || 60,
        model: model.trim() || undefined,
        ...(audio ? { audio: { ...audio, offset: Math.max(0, Number(offset) || 0) } } : {}),
      }),
    );
    if (!res) return;
    await store.refreshProject();
    await store.refreshProjects();
    store.modal = null;
  }

  async function addMusic(file: File | undefined) {
    if (!file || !file.type.startsWith('audio/')) return store.notify('Drop an audio file (mp3, wav, m4a…)', 'error');
    analyzing = true;
    try {
      const [uploaded, analysis] = await Promise.all([api.uploadAudio(project.slug, file), file.arrayBuffer().then(analyzeBeats)]);
      await api.updateProject(project.slug, {
        audio: { file: uploaded.file, name: file.name, offset: 0, ...analysis },
      });
      offset = 0;
      await store.refreshProject();
      store.notify(`Found ${analysis.beats.length} beats at ~${Math.round(analysis.bpm)} BPM`);
    } catch (e) {
      store.notify(`Couldn't read that audio file: ${(e as Error).message}`, 'error');
    } finally {
      analyzing = false;
    }
  }

  async function removeMusic() {
    await store.run(() => api.updateProject(project.slug, { audio: null }));
    await store.refreshProject();
  }
</script>

<Modal title="Project settings" onclose={() => (store.modal = null)}>
  <div class="space-y-4 text-[14px]">
    <label class="block"><span class="field-label">Name</span><input class="field w-full" bind:value={name} /></label>
    <label class="block">
      <span class="field-label">Codebase <span class="font-normal text-faint">(read-only for Claude)</span></span>
      <input class="field w-full font-mono text-[13px]" bind:value={codebase} />
    </label>
    <label class="block">
      <span class="field-label">Running app URL</span>
      <input class="field w-full" bind:value={url} placeholder="http://localhost:3000" />
    </label>
    <div class="grid grid-cols-2 gap-4">
      <label class="block">
        <span class="field-label">Frame rate</span>
        <select class="field w-full" bind:value={fps}>
          {#each [24, 30, 50, 60] as v}<option value={v}>{v} fps</option>{/each}
        </select>
      </label>
      <label class="block">
        <span class="field-label">Claude model</span>
        <input class="field w-full font-mono text-[13px]" bind:value={model} placeholder="Claude Code default" list="models" />
        <datalist id="models">
          <option value="claude-opus-5-5"></option>
          <option value="claude-fable-5-1"></option>
          <option value="claude-sonnet-5-5"></option>
        </datalist>
      </label>
    </div>
    <p class="-mt-2 text-[12px] text-faint">Canvas: {project.width}×{project.height}. Export at other resolutions from the Render tab.</p>

    <div>
      <div class="mb-1.5 flex items-baseline justify-between">
        <span class="field-label mb-0">Music</span>
        <button class="text-[12px] font-medium text-violet-300 hover:underline" onclick={() => (store.modal = 'soundtrack')}>Generate a soundtrack instead</button>
      </div>
      {#if audio}
        <div class="rounded-xl border border-line p-3.5">
          <div class="flex items-center gap-3">
            <div class="grid size-9 place-items-center rounded-lg bg-violet-400/15 text-violet-300"><Music size={16} /></div>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{audio.name}</div>
              <div class="text-[12px] text-muted">
                {audio.duration.toFixed(1)}s · ~{Math.round(audio.bpm ?? 0)} BPM · {audio.beats.length} beats, {audio.downbeats.length} downbeats
              </div>
            </div>
            <button class="grid size-8 place-items-center rounded-md text-faint hover:bg-red-400/10 hover:text-red-400" title="Remove music" onclick={removeMusic}
              ><Trash2 size={15} /></button
            >
          </div>
          <label class="mt-3 flex items-center gap-2 text-[13px] text-fg-soft">
            Start the video at
            <input class="field h-8 w-20 text-right" type="number" step="0.01" min="0" bind:value={offset} />
            seconds into the track
          </label>
          <p class="mt-2 text-[12px] text-faint">Beats show on the timeline in violet. Claude gets the beat times for each scene, so you can ask it to land moments on the music.</p>
        </div>
      {:else}
        <button
          class="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center transition {dragging ? 'border-violet-400 bg-violet-400/10' : 'border-line-strong hover:bg-raised'}"
          ondragover={(e) => {
            e.preventDefault();
            dragging = true;
          }}
          ondragleave={() => (dragging = false)}
          ondrop={(e) => {
            e.preventDefault();
            dragging = false;
            addMusic(e.dataTransfer?.files[0]);
          }}
          onclick={() => fileInput?.click()}
          disabled={analyzing}
        >
          {#if analyzing}
            <span class="size-4 animate-spin rounded-full border-2 border-line-strong border-t-violet-600"></span>
            <span class="text-[13px] font-medium">Detecting beats…</span>
          {:else}
            <Upload size={18} class="text-faint" />
            <span class="text-[13px] font-medium">Drop a music track, or click to choose</span>
            <span class="text-[12px] text-faint">Beats and downbeats are detected so cuts can land on the music</span>
          {/if}
        </button>
        <input bind:this={fileInput} type="file" accept="audio/*" class="hidden" onchange={(e) => addMusic((e.currentTarget as HTMLInputElement).files?.[0])} />
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <button class="rounded-lg px-3.5 py-2 text-[14px] font-medium text-fg-soft hover:bg-raised" onclick={() => (store.modal = null)}>Cancel</button>
    <button class="rounded-lg bg-spindle px-4 py-2 text-[14px] font-semibold text-ink hover:bg-spindle-hover" onclick={save}>Save</button>
  {/snippet}
</Modal>

<style>
  @reference '../app.css';
  .field-label {
    @apply mb-1.5 block text-[13px] font-medium text-fg-soft;
  }
  .field {
    @apply h-10 rounded-lg border border-line bg-panel px-3 outline-none transition focus:border-spindle/50 focus:ring-2 focus:ring-spindle/15;
  }
</style>
