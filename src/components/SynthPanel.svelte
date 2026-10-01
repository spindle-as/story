<script lang="ts">
  import { Sparkles, WandSparkles } from '@lucide/svelte';
  import { api, type ScoreStatus } from '../lib/api';
  import { store } from '../lib/store.svelte';

  const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const slug = store.project!.slug;

  let status = $state<ScoreStatus | null>(null);
  let mood = $state('minimal');
  let autoTempo = $state(true);
  let bpm = $state(104);
  let key = $state('');
  let sfx = $state(false);
  let busy = $state(false);
  let result = $state<{ summary: string; warnings: string[] } | null>(null);
  let request = $state('');

  const selectedMood = $derived(status?.moods.find((m) => m.id === mood));

  async function load() {
    status = await api.scoreStatus(slug);
    if (status.score?.mood) mood = status.score.mood;
    if (status.score) bpm = Math.round(status.score.bpm);
  }
  load();

  async function compose() {
    busy = true;
    result = null;
    const out = await store.run(() => api.composeScore(slug, { mood, bpm: autoTempo ? undefined : bpm, key: key || undefined, sfx }));
    busy = false;
    if (out) {
      result = out;
      await load();
      await store.refreshProject();
    }
  }

  async function askClaude() {
    const text = request.trim();
    if (!text) return;
    store.modal = null;
    store.panel = 'project';
    await store.run(() =>
      api.send(slug, '_project', {
        text: `Built-in synth soundtrack: ${text}\n\nWork in score.json (and Story.sound cues inside scenes where a sound belongs to a specific moment). Render with \`story score\`.`,
      }),
    );
  }
</script>

<div class="space-y-5">
  <p class="text-[13px] leading-relaxed text-muted">
    Offline and free: a score of chords and patterns played by simple built-in instruments. It sounds like a sketch, not a finished track; use it for timing drafts or when you can't use ElevenLabs.
  </p>

  <div class="grid grid-cols-4 gap-2">
    {#each status?.moods ?? [] as m}
      <button
        class="rounded-lg border px-3 py-2 text-left transition {mood === m.id ? 'border-fg ring-1 ring-fg' : 'border-line hover:border-line-strong'}"
        onclick={() => (mood = m.id)}
      >
        <div class="text-[13px] font-semibold">{m.label}</div>
        <div class="text-[11px] text-faint">{m.bpm[0]}–{m.bpm[1]} BPM</div>
      </button>
    {/each}
  </div>

  <div class="grid grid-cols-3 gap-3 text-[13px]">
    <label class="flex h-9 items-center gap-2 rounded-lg border border-line px-3">
      <input type="checkbox" bind:checked={autoTempo} class="size-4 accent-spindle" />
      {#if autoTempo}<span class="text-fg-soft">Tempo fits cuts</span>{:else}<input type="number" min="40" max="200" step="0.5" bind:value={bpm} class="w-full min-w-0 bg-transparent outline-none" /><span class="text-faint">BPM</span>{/if}
    </label>
    <select bind:value={key} class="h-9 rounded-lg border border-line bg-panel px-3 outline-none">
      <option value="">Key: mood default{selectedMood ? ` (${selectedMood.key})` : ''}</option>
      {#each KEYS as k}<option value={k}>Key: {k}</option>{/each}
    </select>
    <label class="flex h-9 items-center gap-2 rounded-lg border border-line px-3">
      <input type="checkbox" bind:checked={sfx} class="size-4 accent-spindle" />
      <span class="truncate text-fg-soft">Risers and hits</span>
    </label>
  </div>

  <div class="flex items-center justify-end gap-3">
    {#if status?.score}<span class="text-[12px] text-amber-300">Replaces score.json</span>{/if}
    <button
      class="flex items-center gap-2 rounded-lg bg-spindle px-4 py-2 text-[14px] font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40"
      onclick={compose}
      disabled={busy || !status}
    >
      {#if busy}<span class="size-3.5 animate-spin rounded-full border-2 border-ink/30 border-t-ink"></span>Rendering…{:else}<WandSparkles size={15} />Generate with synth{/if}
    </button>
  </div>

  {#if result}
    <div class="rounded-lg bg-raised p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-soft">{result.summary}{#if result.warnings.length}{'\n\n'}⚠ {result.warnings.join('\n⚠ ')}{/if}</div>
  {/if}
  {#if status?.error}<div class="rounded-lg bg-red-400/10 p-3 text-[13px] text-red-400">{status.error}</div>{/if}

  <div class="flex gap-2">
    <input
      class="h-9 min-w-0 flex-1 rounded-lg border border-line px-3 text-[13px] outline-none focus:border-spindle/50"
      placeholder="Ask Claude to edit the score, e.g. slower, add a melody in the outro"
      bind:value={request}
      onkeydown={(e) => e.key === 'Enter' && askClaude()}
    />
    <button class="flex items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-raised disabled:opacity-40" onclick={askClaude} disabled={!request.trim()}><Sparkles size={14} />Ask</button>
  </div>
</div>
