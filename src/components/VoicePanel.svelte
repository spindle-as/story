<script lang="ts">
  import { ChevronRight, Mic, Play, Plus, Search, Sparkles, Square, Trash2 } from '@lucide/svelte';
  import type { VoiceLine, VoiceoverFile } from '../../shared/voice';
  import { wordCount } from '../../shared/voice';
  import { api, type VoiceOption } from '../lib/api';
  import { fmtTime, store } from '../lib/store.svelte';

  const slug = $derived(store.project!.slug);
  const status = $derived(store.voice);
  const vo = $derived(status?.voiceover);

  let lines = $state<VoiceLine[]>([]);
  let synced = '';
  let busy = $state<string | null>(null);
  let picking = $state(false);
  let voices = $state<VoiceOption[] | null>(null);
  let search = $state('');
  let showSettings = $state(false);
  let previewAudio: HTMLAudioElement | null = null;
  let previewing = $state<string | null>(null);

  // Keep a local, editable copy of the lines in sync with the server (unless mid-edit).
  $effect(() => {
    const incoming = JSON.stringify(status?.voiceover.lines ?? []);
    if (incoming !== synced && !saveTimer) {
      synced = incoming;
      lines = JSON.parse(incoming);
    }
  });

  $effect(() => {
    if (!store.voice && store.project) store.loadVoice();
  });

  const resolved = $derived(new Map((status?.lines ?? []).map((l) => [l.id, l])));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persist(delay = 700) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const body = $state.snapshot(lines) as VoiceLine[];
      synced = JSON.stringify(body);
      const out = await store.run(() => api.saveVoice(slug, { lines: body }));
      if (out) store.voice = out;
      await store.loadVoice();
    }, delay);
  }

  async function saveSettings(patch: Partial<VoiceoverFile>) {
    const out = await store.run(() => api.saveVoice(slug, patch));
    if (out) {
      store.voice = out;
      await store.loadVoice();
    }
  }

  function addLine(sceneId: string) {
    const here = store.scenes[store.sceneIndex]?.id === sceneId;
    lines.push({ id: crypto.randomUUID().slice(0, 8), scene: sceneId, t: here ? Number(store.localTime.toFixed(2)) : 0.5, text: '' });
    persist(0);
  }

  async function record(id?: string) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      const out = await store.run(() => api.saveVoice(slug, { lines: $state.snapshot(lines) as VoiceLine[] }));
      if (out) store.voice = out;
    }
    busy = id ?? 'all';
    const out = await store.run(() => (id ? api.recordLine(slug, id) : api.recordPending(slug)));
    busy = null;
    if (out) store.voice = out;
    await store.loadVoice();
  }

  function playLine(line: VoiceLine) {
    const r = resolved.get(line.id);
    if (!r?.file) return;
    store.pause();
    store.engine.previewVoice(`/p/${slug}/${r.file}`);
  }

  function jump(sceneId: string, t: number) {
    const index = store.scenes.findIndex((s) => s.id === sceneId);
    store.pause();
    if (store.mode === 'scene') {
      store.selectScene(sceneId, { keepTime: true });
      store.seek(t);
    } else store.seek((store.starts[index] ?? 0) + t);
  }

  async function openPicker() {
    picking = !picking;
    if (picking && !voices) voices = (await store.run(() => api.voices())) ?? [];
  }

  async function searchVoices() {
    voices = (await store.run(() => api.voices(search.trim() || undefined))) ?? [];
  }

  function preview(v: VoiceOption) {
    previewAudio?.pause();
    if (previewing === v.id || !v.preview) {
      previewing = null;
      return;
    }
    previewAudio = new Audio(v.preview);
    previewAudio.onended = () => (previewing = null);
    previewAudio.play();
    previewing = v.id;
  }

  async function chooseVoice(v: VoiceOption) {
    previewAudio?.pause();
    previewing = null;
    picking = false;
    await saveSettings({ voice: { id: v.id, name: v.name } });
  }

  async function writeScript() {
    store.panel = 'project';
    await store.run(() =>
      api.send(slug, '_project', {
        text: `Write the voice-over script for this video in voiceover.json.\n\nDirection: ${vo?.direction ?? ''}\n\nLook at every scene (and the codebase for the product's own words), check the word budgets and timing with \`story voice\`, and place each line right after the moment it talks about. Some scenes can stay silent. Don't record anything; tell me when the script is ready.`,
      }),
    );
  }

  const describeVoice = (v: VoiceOption) =>
    [v.labels?.gender, v.labels?.age, v.labels?.accent, v.labels?.description ?? v.labels?.descriptive, v.labels?.use_case ?? v.labels?.use_case].filter(Boolean).join(' · ');
</script>

<div class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
  {#if !status || !vo}
    <div class="grid flex-1 place-items-center"><span class="size-4 animate-spin rounded-full border-2 border-line-strong border-t-fg"></span></div>
  {:else}
    <div class="space-y-5 p-4 text-[13px]">
      {#if !status.key.configured}
        <div class="rounded-lg bg-violet-400/10 px-3 py-2.5 text-violet-300">
          Voice-overs are recorded with ElevenLabs.
          <button class="font-semibold underline" onclick={() => (store.modal = 'soundtrack')}>Add your API key</button> in the Soundtrack dialog. You can write the script before that.
        </div>
      {/if}

      <section class="space-y-2">
        <div class="flex items-center gap-2">
          <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-teal-400/10 text-teal-300"><Mic size={16} /></div>
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">{vo.voice?.name ?? 'No voice picked'}</div>
            <div class="text-[12px] text-muted">{status.characters} characters · {status.lines.length} line{status.lines.length === 1 ? '' : 's'}</div>
          </div>
          <button class="rounded-md border border-line px-2.5 py-1.5 font-medium hover:bg-raised disabled:opacity-40" disabled={!status.key.configured} onclick={openPicker}>
            {vo.voice ? 'Change voice' : 'Pick a voice'}
          </button>
        </div>

        {#if picking}
          <div class="rounded-lg border border-line">
            <div class="flex gap-1.5 border-b border-line/60 p-2">
              <input class="h-8 min-w-0 flex-1 rounded-md border border-line px-2.5 outline-none" placeholder="Search voices, e.g. calm narrator" bind:value={search} onkeydown={(e) => e.key === 'Enter' && searchVoices()} />
              <button class="grid size-8 place-items-center rounded-md border border-line hover:bg-raised" onclick={searchVoices} title="Search"><Search size={14} /></button>
            </div>
            <div class="scrollbar-thin max-h-72 divide-y divide-line/60 overflow-y-auto">
              {#if !voices}
                <div class="p-4 text-center text-faint">Loading voices…</div>
              {:else if !voices.length}
                <div class="p-4 text-center text-faint">No voices found.</div>
              {/if}
              {#each voices ?? [] as v (v.id)}
                <div class="flex items-center gap-2 px-2.5 py-1.5 {vo.voice?.id === v.id ? 'bg-teal-400/10' : ''}">
                  <button class="grid size-7 shrink-0 place-items-center rounded-full bg-raised hover:bg-line disabled:opacity-30" disabled={!v.preview} onclick={() => preview(v)} title="Listen">
                    {#if previewing === v.id}<Square size={10} fill="currentColor" />{:else}<Play size={11} fill="currentColor" class="ml-0.5" />{/if}
                  </button>
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium">{v.name}</div>
                    <div class="truncate text-[11px] text-faint">{describeVoice(v) || v.category}</div>
                  </div>
                  <button class="rounded-md border border-line px-2 py-1 text-[12px] font-medium hover:bg-raised" onclick={() => chooseVoice(v)}>Use</button>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <label class="block">
          <span class="mb-1 block text-[12px] text-muted">Direction for the read and the script</span>
          <textarea rows="2" class="w-full resize-none rounded-lg border border-line px-2.5 py-1.5 leading-snug outline-none focus:border-spindle/50" value={vo.direction ?? ''} onchange={(e) => saveSettings({ direction: e.currentTarget.value })}></textarea>
        </label>

        <button class="flex items-center gap-1 text-[12px] font-medium text-fg-soft" onclick={() => (showSettings = !showSettings)}>
          <ChevronRight size={13} class="transition {showSettings ? 'rotate-90' : ''}" />Voice settings and mix
        </button>
        {#if showSettings}
          <div class="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-raised p-3">
            <label class="col-span-2 flex items-center gap-2">
              Model
              <select class="h-7 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 outline-none" value={vo.model} onchange={(e) => saveSettings({ model: e.currentTarget.value })}>
                {#each status.models as m}<option value={m.id}>{m.label}</option>{/each}
              </select>
            </label>
            {#each [['stability', 'Stability', 0, 1], ['similarity', 'Similarity', 0, 1], ['style', 'Style', 0, 1], ['speed', 'Speed', 0.7, 1.2]] as [key, label, min, max]}
              <label class="flex items-center justify-between gap-2">
                {label}
                <input type="range" {min} {max} step="0.05" class="w-24 accent-spindle" value={vo.settings[key as keyof typeof vo.settings]} onchange={(e) => saveSettings({ settings: { ...vo.settings, [key as string]: Number(e.currentTarget.value) } })} />
              </label>
            {/each}
            <label class="flex items-center justify-between gap-2">
              Voice level
              <input type="range" min="0" max="2" step="0.05" class="w-24 accent-spindle" value={vo.gain} onchange={(e) => saveSettings({ gain: Number(e.currentTarget.value) })} />
            </label>
            <label class="flex items-center justify-between gap-2" title="Music level while the voice speaks">
              Music under voice
              <input type="range" min="0" max="1" step="0.05" class="w-24 accent-spindle" value={vo.duck} onchange={(e) => saveSettings({ duck: Number(e.currentTarget.value) })} />
            </label>
            <label class="col-span-2 flex items-center gap-2">
              <input type="checkbox" class="size-4 accent-spindle" checked={vo.captions} onchange={(e) => saveSettings({ captions: e.currentTarget.checked })} />
              Export captions (.srt) with the video
            </label>
            <p class="col-span-2 text-[11px] text-faint">Changing the voice, model or these settings means lines need recording again.</p>
          </div>
        {/if}
      </section>

      <section>
        <div class="mb-2 flex items-center gap-2">
          <h3 class="flex-1 font-semibold">Script</h3>
          <button class="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 font-medium hover:bg-raised" onclick={writeScript}>
            <Sparkles size={13} />Write with Claude
          </button>
        </div>

        <div class="space-y-3">
          {#each store.scenes as scene, i (scene.id)}
            {@const sceneLines = lines.filter((l) => l.scene === scene.id).sort((a, b) => a.t - b.t)}
            {@const current = store.scenes[store.sceneIndex]?.id === scene.id}
            {@const words = sceneLines.reduce((n, l) => n + wordCount(l.text), 0)}
            {@const budget = status.budgets[scene.id] ?? 0}
            <div class="rounded-lg border {current ? 'border-teal-400/50 ring-1 ring-teal-400/20' : 'border-line'}">
              <div class="flex items-center gap-2 px-2.5 py-1.5">
                <button class="min-w-0 flex-1 truncate text-left font-medium" onclick={() => store.selectScene(scene.id)}>
                  <span class="text-faint">{i + 1}</span> {scene.title}
                </button>
                <span class="shrink-0 font-mono text-[11px] {words > budget ? 'text-amber-300' : 'text-faint'}" title="Words used / words that fit">{words}/{budget} words</span>
                <button class="grid size-6 place-items-center rounded text-muted hover:bg-raised" title="Add a line" onclick={() => addLine(scene.id)}><Plus size={13} /></button>
              </div>
              {#each sceneLines as line (line.id)}
                {@const r = resolved.get(line.id)}
                <div class="border-t border-line/60 px-2.5 py-2">
                  <textarea
                    rows="2"
                    class="w-full resize-none rounded-md border border-transparent bg-raised px-2 py-1.5 leading-snug outline-none focus:border-spindle/50 focus:bg-ink"
                    placeholder="What the narrator says here…"
                    bind:value={line.text}
                    oninput={() => persist()}
                  ></textarea>
                  <div class="mt-1.5 flex items-center gap-1.5">
                    <button class="font-mono text-[11px] text-muted hover:text-fg" title="Go to this moment" onclick={() => jump(scene.id, line.t)}>at</button>
                    <input type="number" min="0" step="0.05" class="h-6 w-16 rounded border border-line px-1.5 text-right font-mono text-[11px] outline-none" bind:value={line.t} oninput={() => persist()} />
                    <button class="text-[11px] text-faint hover:text-fg-soft" title="Move to the playhead" onclick={() => { line.t = Number(store.localTime.toFixed(2)); persist(0); }}>← {fmtTime(store.localTime)}s</button>
                    <div class="flex-1"></div>
                    {#if r?.file && !r.stale}
                      <span class="rounded bg-teal-400/10 px-1.5 py-0.5 font-mono text-[11px] text-teal-300">{r.duration?.toFixed(1)}s</span>
                      <button class="grid size-6 place-items-center rounded text-muted hover:bg-raised" title="Listen" onclick={() => playLine(line)}><Play size={12} /></button>
                    {:else if line.text.trim()}
                      <span class="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">{r?.stale ? 'Changed' : 'Not recorded'}</span>
                    {/if}
                    <button
                      class="flex h-6 items-center gap-1 rounded border border-line px-1.5 text-[11px] font-medium hover:bg-raised disabled:opacity-40"
                      disabled={!vo.voice || !status.key.configured || !line.text.trim() || !!busy}
                      title={vo.voice ? 'Record this line (uses ElevenLabs credits)' : 'Pick a voice first'}
                      onclick={() => record(line.id)}
                    >
                      {#if busy === line.id}<span class="size-2.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-fg"></span>{:else}<Mic size={11} />{/if}{r?.file && !r.stale ? 'Retake' : 'Record'}
                    </button>
                    <button class="grid size-6 place-items-center rounded text-faint hover:bg-red-400/10 hover:text-red-400" title="Delete line" onclick={() => { lines = lines.filter((l) => l.id !== line.id); persist(0); }}><Trash2 size={12} /></button>
                  </div>
                  {#each r?.issues ?? [] as issue}
                    <div class="mt-1 text-[11px] text-amber-300">⚠ {issue}</div>
                  {/each}
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </section>

      {#if status.pending.length}
        <div class="sticky bottom-0 -mx-4 border-t border-line bg-panel/95 px-4 py-3 backdrop-blur">
          <button
            class="flex w-full items-center justify-center gap-2 rounded-lg bg-spindle py-2 font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40"
            disabled={!vo.voice || !status.key.configured || !!busy}
            onclick={() => record()}
          >
            {#if busy === 'all'}<span class="size-3.5 animate-spin rounded-full border-2 border-ink/30 border-t-ink"></span>Recording…{:else}<Mic size={14} />Record {status.pending.length} line{status.pending.length === 1 ? '' : 's'}{/if}
          </button>
          <p class="mt-1.5 text-center text-[11px] text-faint">{vo.voice ? 'Uses ElevenLabs credits, about one per character.' : 'Pick a voice first.'}</p>
        </div>
      {/if}
    </div>
  {/if}
</div>
