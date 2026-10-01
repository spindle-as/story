<script lang="ts">
  import { ChevronRight, Play, Plus, RefreshCw, Sparkles, Trash2, Upload, Volume2, VolumeX } from '@lucide/svelte';
  import type { ResolvedCue, SoundCue } from '../../shared/sound';
  import { api } from '../lib/api';
  import { fmtTime, store } from '../lib/store.svelte';

  const slug = $derived(store.project!.slug);
  const scene = $derived(store.scene);
  const st = $derived(store.sounds);
  const library = $derived(st?.sounds.library ?? []);
  const available = $derived(st?.available ?? {});

  let busy = $state<string | null>(null);
  let addSound = $state('tick');
  let request = $state('');
  let showLibrary = $state(false);
  let newLabel = $state('');
  let newPrompt = $state('');
  let newSeconds = $state(0.6);
  let fileInput = $state<HTMLInputElement>();

  /** This scene's cues as rows: one per manual cue, one per automatic cue (a typing run is one row). */
  const rows = $derived.by(() => {
    if (!st || !scene) return [];
    const seen = new Map<string, { cue: ResolvedCue; count: number }>();
    for (const cue of st.cues.filter((c) => c.scene === scene.id)) {
      const row = seen.get(cue.id);
      if (row) row.count++;
      else seen.set(cue.id, { cue, count: 1 });
    }
    return [...seen.values()];
  });

  const manual = $derived<SoundCue[]>(scene ? (st?.sounds.scenes[scene.id]?.cues ?? []) : []);
  const muted = $derived<string[]>(scene ? (st?.sounds.scenes[scene.id]?.muted ?? []) : []);

  async function run<T>(key: string, fn: () => Promise<T>) {
    busy = key;
    const out = await store.run(fn);
    busy = null;
    if (out && typeof out === 'object' && 'cues' in out) {
      store.sounds = out as any;
      await store.loadSounds();
    }
    return out;
  }

  let saveTimer: ReturnType<typeof setTimeout>;
  function saveCues(cues: SoundCue[], delay = 0) {
    if (!scene) return;
    const id = scene.id;
    // Show the change immediately; persist (debounced for sliders and number inputs).
    if (store.sounds) store.sounds.sounds.scenes[id] = { ...(store.sounds.sounds.scenes[id] ?? { cues: [] }), cues };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => run('save', () => api.saveSceneSounds(slug, id, { cues })), delay);
  }

  function add() {
    const t = Number(store.localTime.toFixed(3));
    saveCues([...manual, { id: crypto.randomUUID().slice(0, 8), t, sound: addSound, gain: 1 }]);
    if (available[addSound]) store.engine.preview(addSound);
  }

  function updateCue(id: string, patch: Partial<SoundCue>, delay = 0) {
    saveCues(manual.map((c) => (c.id === id ? { ...c, ...patch } : c)), delay);
  }

  function removeCue(id: string) {
    saveCues(manual.filter((c) => c.id !== id));
  }

  function toggleMute(id: string) {
    if (!scene) return;
    const next = muted.includes(id) ? muted.filter((m) => m !== id) : [...muted, id];
    run('mute', () => api.saveSceneSounds(slug, scene!.id, { muted: next }));
  }

  function jump(local: number) {
    store.pause();
    store.seek(store.mode === 'scene' ? local : (store.starts[store.sceneIndex] ?? 0) + local);
  }

  function describe(row: { cue: ResolvedCue; count: number }) {
    const c = row.cue;
    if (!c.auto) return null;
    if (c.id.includes(':typing:')) return `Typing · ${row.count} keystrokes`;
    if (c.id.includes(':click:')) return 'Cursor click';
    if (c.id.startsWith('auto:cut:')) return 'Whoosh on the cut';
    return 'Story.sound() in the scene';
  }

  async function askClaude() {
    const text = request.trim();
    if (!text || !scene) return;
    store.panel = 'scene';
    await store.run(() =>
      api.send(slug, scene!.id, {
        text: `Sound design: ${text}\n\nFind the exact moments in the scene's timeline and place sound cues for them in sounds.json (see \`story sounds\`). Use the library sounds, or add a new library sound described in words if none fits.`,
      }),
    );
    request = '';
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    await run('upload', () => api.uploadSound(slug, file));
  }

  async function createSound() {
    if (!newPrompt.trim()) return;
    await run('create', () => api.addSound(slug, { label: newLabel || newPrompt.slice(0, 32), prompt: newPrompt, seconds: newSeconds }));
    newLabel = '';
    newPrompt = '';
  }
</script>

<div class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
  {#if !st || !scene}
    <div class="grid flex-1 place-items-center"><span class="size-4 animate-spin rounded-full border-2 border-line-strong border-t-fg"></span></div>
  {:else}
    <div class="space-y-5 p-4 text-[13px]">
      {#if st.missing.length}
        <div class="rounded-lg bg-amber-300/10 px-3 py-2.5 text-amber-300">
          <div class="font-medium">{st.missing.length} sound{st.missing.length === 1 ? '' : 's'} in use {st.missing.length === 1 ? 'has' : 'have'} no recording yet, so {st.missing.length === 1 ? 'it is' : 'they are'} silent.</div>
          <div class="mt-0.5 text-[12px] opacity-80">{st.missing.map((id) => library.find((d) => d.id === id)?.label ?? id).join(', ')}</div>
          <div class="mt-2 flex gap-2">
            {#if st.key.configured}
              <button class="rounded-md bg-amber-300 px-2.5 py-1 font-semibold text-ink disabled:opacity-50" disabled={!!busy} onclick={() => run('missing', () => api.generateMissingSounds(slug))}>
                {busy === 'missing' ? 'Generating…' : 'Generate with ElevenLabs'}
              </button>
            {:else}
              <span class="text-[12px]">Add an ElevenLabs key in Soundtrack, or upload your own sounds in the library below.</span>
            {/if}
          </div>
        </div>
      {/if}

      <section>
        <div class="mb-2 flex items-center gap-2">
          <h3 class="flex-1 font-semibold">Sounds in this scene</h3>
          <select class="h-8 rounded-md border border-line bg-panel px-2 outline-none" bind:value={addSound}>
            {#each library as def}<option value={def.id}>{def.label}</option>{/each}
          </select>
          <button class="flex h-8 items-center gap-1 rounded-md bg-spindle px-2.5 font-semibold text-ink hover:bg-spindle-hover" onclick={add}>
            <Plus size={14} />at {fmtTime(store.localTime)}s
          </button>
        </div>

        {#if rows.length}
          <div class="divide-y divide-line/60 rounded-lg border border-line">
            {#each rows as row (row.cue.id)}
              {@const c = row.cue}
              {@const cue = manual.find((m) => m.id === c.id)}
              <div class="flex items-center gap-2 px-2.5 py-1.5 {c.muted ? 'opacity-45' : ''}">
                <button class="w-14 shrink-0 text-left font-mono text-[12px] text-muted hover:text-fg" title="Go to this moment" onclick={() => jump(c.local)}>{c.local.toFixed(2)}s</button>
                {#if cue}
                  <select
                    class="h-7 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 outline-none"
                    value={cue.sound}
                    onchange={(e) => updateCue(cue.id, { sound: e.currentTarget.value })}
                  >
                    {#each library as def}<option value={def.id}>{def.label}{available[def.id] ? '' : ' (not generated)'}</option>{/each}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    class="h-7 w-16 rounded border border-line px-1.5 text-right font-mono text-[12px] outline-none"
                    title="Time in the scene (seconds)"
                    value={cue.t}
                    oninput={(e) => updateCue(cue.id, { t: Number(e.currentTarget.value) }, 400)}
                  />
                  <input type="range" min="0" max="2" step="0.05" class="w-14 accent-spindle" title="Volume" value={cue.gain ?? 1} oninput={(e) => updateCue(cue.id, { gain: Number(e.currentTarget.value) }, 400)} />
                {:else}
                  <div class="min-w-0 flex-1 truncate">
                    <span class="font-medium">{c.label}</span>
                    <span class="text-faint"> · {describe(row)}</span>
                  </div>
                {/if}
                <button class="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-raised hover:text-fg disabled:opacity-30" title="Listen" disabled={!available[c.sound]} onclick={() => store.engine.preview(c.sound, c.gain)}>
                  <Play size={13} />
                </button>
                {#if cue}
                  <button class="grid size-7 shrink-0 place-items-center rounded text-faint hover:bg-red-400/10 hover:text-red-400" title="Remove" onclick={() => removeCue(cue.id)}><Trash2 size={13} /></button>
                {:else}
                  <button class="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-raised" title={c.muted ? 'Turn on' : 'Turn off'} onclick={() => toggleMute(c.id)}>
                    {#if c.muted}<VolumeX size={13} />{:else}<Volume2 size={13} />{/if}
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="rounded-lg border border-dashed border-line px-3 py-4 text-center text-faint">No sounds yet. Move the playhead to a moment and add one.</p>
        {/if}
        <p class="mt-2 text-[12px] text-faint">Cursor clicks and typing get sounds automatically. Drag a placed sound's marker on the timeline to move it.</p>
      </section>

      <section>
        <h3 class="mb-2 font-semibold">Ask Claude</h3>
        <div class="flex gap-2">
          <input
            class="h-8 min-w-0 flex-1 rounded-md border border-line px-2.5 outline-none focus:border-spindle/50"
            placeholder="e.g. a tick each time a checklist item gets checked"
            bind:value={request}
            onkeydown={(e) => e.key === 'Enter' && askClaude()}
          />
          <button class="flex items-center gap-1 rounded-md border border-line px-2.5 font-medium hover:bg-raised disabled:opacity-40" disabled={!request.trim()} onclick={askClaude}><Sparkles size={13} />Ask</button>
        </div>
      </section>

      <section class="space-y-2.5">
        <h3 class="font-semibold">Whole video</h3>
        <label class="flex items-center gap-2">
          <input type="checkbox" class="size-4 accent-spindle" checked={st.sounds.whooshOnCuts} onchange={(e) => run('settings', () => api.soundSettings(slug, { whooshOnCuts: e.currentTarget.checked }))} />
          Whoosh on every cut <span class="text-faint">(turn single ones off in each scene)</span>
        </label>
        <label class="flex items-center gap-2">
          Effects level
          <input type="range" min="0" max="2" step="0.05" class="w-32 accent-spindle" value={st.sounds.gain ?? 1} onchange={(e) => run('settings', () => api.soundSettings(slug, { gain: Number(e.currentTarget.value) }))} />
          <span class="font-mono text-[12px] text-faint">{Math.round((st.sounds.gain ?? 1) * 100)}%</span>
        </label>
      </section>

      <section>
        <button class="flex w-full items-center gap-1 font-semibold" onclick={() => (showLibrary = !showLibrary)}>
          <ChevronRight size={14} class="transition {showLibrary ? 'rotate-90' : ''}" />Sound library <span class="font-normal text-faint">· {library.length}</span>
        </button>
        {#if showLibrary}
          <div class="mt-2 divide-y divide-line/60 rounded-lg border border-line">
            {#each library as def (def.id)}
              <div class="flex items-center gap-2 px-2.5 py-1.5">
                <div class="min-w-0 flex-1">
                  <div class="truncate font-medium">{def.label} {#if def.variant && def.variant > 1}<span class="font-normal text-faint">· v{def.variant}</span>{/if}</div>
                  <div class="truncate text-[11px] text-faint" title={def.prompt}>{def.source === 'upload' ? 'Your upload' : def.prompt}</div>
                </div>
                <button class="grid size-7 place-items-center rounded text-muted hover:bg-raised disabled:opacity-30" title="Listen" disabled={!available[def.id]} onclick={() => store.engine.preview(def.id)}><Play size={13} /></button>
                {#if def.prompt}
                  <button
                    class="flex h-7 items-center gap-1 rounded border border-line px-2 text-[12px] font-medium hover:bg-raised disabled:opacity-40"
                    title={available[def.id] ? 'Generate a different version' : 'Generate with ElevenLabs'}
                    disabled={!st.key.configured || !!busy}
                    onclick={() => run(`gen:${def.id}`, () => api.generateSound(slug, def.id))}
                  >
                    {#if busy === `gen:${def.id}`}<span class="size-3 animate-spin rounded-full border-2 border-line-strong border-t-fg"></span>{:else if available[def.id]}<RefreshCw size={12} />New take{:else}Generate{/if}
                  </button>
                {/if}
              </div>
            {/each}
          </div>
          <div class="mt-3 space-y-2 rounded-lg bg-raised p-3">
            <div class="font-medium">Describe a new sound</div>
            <input class="h-8 w-full rounded-md border border-line bg-panel px-2.5 outline-none" placeholder="Name, e.g. Checklist tick" bind:value={newLabel} />
            <input class="h-8 w-full rounded-md border border-line bg-panel px-2.5 outline-none" placeholder="Sound, e.g. soft pencil tick on paper, short and dry" bind:value={newPrompt} />
            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1.5 text-muted">Length <input type="number" min="0.5" max="10" step="0.1" class="h-8 w-16 rounded-md border border-line bg-panel px-2 outline-none" bind:value={newSeconds} />s</label>
              <div class="flex-1"></div>
              <button class="flex items-center gap-1 rounded-md border border-line bg-panel px-2.5 py-1.5 font-medium hover:bg-raised" onclick={() => fileInput?.click()}><Upload size={13} />Upload file</button>
              <button class="rounded-md bg-spindle px-3 py-1.5 font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40" disabled={!newPrompt.trim() || !st.key.configured || !!busy} onclick={createSound}>
                {busy === 'create' ? 'Generating…' : 'Generate'}
              </button>
            </div>
            <input bind:this={fileInput} type="file" accept="audio/*" class="hidden" onchange={(e) => upload(e.currentTarget.files?.[0])} />
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>
