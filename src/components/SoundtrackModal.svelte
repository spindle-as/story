<script lang="ts">
  import { AudioWaveform, Magnet, Play } from '@lucide/svelte';
  import { api } from '../lib/api';
  import { store } from '../lib/store.svelte';
  import Modal from './Modal.svelte';
  import MusicPanel from './MusicPanel.svelte';
  import SynthPanel from './SynthPanel.svelte';

  const slug = store.project!.slug;
  let engine = $state<'elevenlabs' | 'synth'>(store.project?.audio?.provider === 'synth' ? 'synth' : 'elevenlabs');
  let snapping = $state(false);

  const audio = $derived(store.project?.audio ?? null);

  /** How far each cut is from the nearest beat of the current track. */
  const cuts = $derived.by(() => {
    if (!audio?.beats.length) return [];
    const beats = audio.beats.map((b) => b - (audio.offset || 0));
    return store.starts.slice(1).map((t, i) => {
      const nearest = beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0]);
      return { t, ms: Math.round((t - nearest) * 1000), from: store.scenes[i]?.title, to: store.scenes[i + 1]?.title };
    });
  });

  async function snap() {
    snapping = true;
    const out = await store.run(() => api.snapToBeat(slug));
    snapping = false;
    if (!out) return;
    store.notify(out.changes.length ? `Adjusted ${out.changes.length} scene${out.changes.length === 1 ? '' : 's'} so every cut lands on a beat` : 'Every cut is already on a beat');
    await store.refreshProject();
  }

  function preview() {
    store.modal = null;
    store.setMode('whole');
    store.seek(0);
    if (store.muted) store.toggleMute();
    store.play();
  }
</script>

<Modal title="Soundtrack" subtitle="Music and sound design that follow your scenes." width={820} onclose={() => (store.modal = null)}>
  <div class="space-y-5 text-[14px]">
    {#if audio}
      <div class="flex items-center gap-3 rounded-xl border border-line p-3">
        <div class="grid size-10 shrink-0 place-items-center rounded-lg bg-violet-400/15 text-violet-300"><AudioWaveform size={18} /></div>
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">{audio.name}</div>
          <div class="text-[12px] text-muted">
            {audio.bpm ? `~${Math.round(audio.bpm)} BPM · ` : ''}{audio.duration.toFixed(1)}s{audio.generated ? '' : ' · uploaded track; generating replaces it'}
          </div>
        </div>
        <button class="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium hover:bg-raised" onclick={preview}>
          <Play size={14} />Play with video
        </button>
      </div>
    {/if}

    <div class="flex rounded-lg bg-raised p-0.5 text-[13px] font-medium">
      {#each [['elevenlabs', 'ElevenLabs music'], ['synth', 'Built-in synth']] as [value, label]}
        <button
          class="flex-1 rounded-md px-3 py-1.5 transition {engine === value ? 'bg-line text-fg shadow-sm' : 'text-muted hover:text-fg'}"
          onclick={() => (engine = value as 'elevenlabs' | 'synth')}>{label}</button
        >
      {/each}
    </div>

    {#if engine === 'elevenlabs'}
      <MusicPanel />
    {:else}
      <SynthPanel />
    {/if}

    {#if cuts.length}
      <section class="border-t border-line/60 pt-4">
        <div class="mb-2 flex items-center gap-3">
          <h3 class="flex-1 text-[13px] font-medium text-fg-soft">Cuts vs. beats of the current track</h3>
          <button
            class="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium hover:bg-raised disabled:opacity-40"
            onclick={snap}
            disabled={snapping}
          >
            {#if snapping}<span class="size-3 animate-spin rounded-full border-2 border-line-strong border-t-fg"></span>{:else}<Magnet size={14} />{/if}Snap cuts to the beat
          </button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          {#each cuts as cut}
            {@const tight = Math.abs(cut.ms) <= 25}
            <span class="rounded-md px-2 py-1 font-mono text-[11.5px] {tight ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-300/10 text-amber-300'}">
              {cut.from} → {cut.to} · {cut.t.toFixed(2)}s · {tight ? 'on beat' : `${cut.ms > 0 ? '+' : ''}${cut.ms}ms`}
            </span>
          {/each}
        </div>
        <p class="mt-2 text-[12px] text-faint">Snapping moves cuts onto the nearest beat. A scene never gets shorter than its animation, and every change is saved as a version.</p>
      </section>
    {/if}
  </div>
</Modal>
