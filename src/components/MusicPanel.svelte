<script lang="ts">
  import { Check, KeyRound, Sparkles, WandSparkles } from '@lucide/svelte';
  import { timeSections, type MusicPlan } from '../../shared/music';
  import { api, type MusicStatus } from '../lib/api';
  import { store } from '../lib/store.svelte';

  const slug = store.project!.slug;
  const MOODS = [
    ['minimal', 'Minimal'],
    ['upbeat', 'Upbeat'],
    ['cinematic', 'Cinematic'],
    ['ambient', 'Ambient'],
  ] as const;

  let status = $state<MusicStatus | null>(null);
  let plan = $state<MusicPlan | null>(null);
  let dirty = $state(false);
  let keyInput = $state('');
  let changingKey = $state(false);
  let busy = $state<null | 'generate' | 'save' | 'use' | 'key'>(null);
  let result = $state<{ summary: string; warnings: string[] } | null>(null);
  let request = $state('');

  // Section times follow the unsaved plan and the current scenes.
  const timedSections = $derived(plan ? timeSections(plan, store.scenes) : []);
  const generating = $derived(busy === 'generate' || busy === 'use' || (status?.generating ?? false) || store.score.status === 'rendering');
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const join = (l: string[] | undefined) => (l ?? []).join(', ');
  const sceneTitle = (id: string) => store.scenes.find((s) => s.id === id)?.title ?? id;
  const fmt = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function load(keepPlan = false) {
    const next = await api.music(slug);
    status = next;
    if (!keepPlan || !plan) {
      // Clone the plain response; the $state proxy can't be structured-cloned.
      plan = structuredClone(next.plan);
      dirty = false;
    }
  }
  load();

  $effect(() => {
    if (store.score.status === 'done') load(true);
  });

  async function saveKey(remove = false) {
    busy = 'key';
    await store.run(() => api.setElevenLabsKey(remove ? null : keyInput));
    keyInput = '';
    changingKey = false;
    busy = null;
    await load(true);
  }

  async function chooseMood(mood: string) {
    if (dirty && !confirm('Replace your edits to the music direction with this mood?')) return;
    const proposed = await store.run(() => api.proposeMusic(slug, mood));
    if (proposed) {
      plan = proposed;
      dirty = true;
    }
  }

  async function save() {
    if (!plan) return;
    busy = 'save';
    const out = await store.run(() => api.saveMusic(slug, $state.snapshot(plan) as MusicPlan));
    busy = null;
    if (out) {
      status = out;
      dirty = false;
    }
  }

  async function generate() {
    if (!plan) return;
    if (dirty || !status?.saved) await save();
    busy = 'generate';
    result = null;
    const out = await store.run(() => api.generateMusic(slug));
    busy = null;
    if (out) {
      result = out;
      await load(true);
      await store.refreshProject();
    }
  }

  async function use(takeId?: string) {
    if (dirty) await save();
    busy = 'use';
    const out = await store.run(() => api.useTake(slug, takeId));
    busy = null;
    if (out) {
      result = out;
      await load(true);
      await store.refreshProject();
    }
  }

  async function askClaude() {
    const text = request.trim();
    if (!text) return;
    if (dirty) await save();
    store.modal = null;
    store.panel = 'project';
    await store.run(() =>
      api.send(slug, '_project', {
        text: `Music: ${text}\n\nRewrite the direction in music.json to fit what each scene shows (check \`story music\` for the section times). Don't generate a new take unless I asked for one; tell me when it's ready to generate.`,
      }),
    );
  }
</script>

{#if status && plan}
  <div class="space-y-5 text-[13px]">
    {#if !status.key.configured || changingKey}
      <div class="rounded-xl border border-violet-400/25 bg-violet-400/10 p-4">
        <div class="flex items-center gap-2 text-[14px] font-semibold"><KeyRound size={15} />Connect ElevenLabs</div>
        <p class="mt-1 text-fg-soft">
          Paste an API key from <a class="font-medium text-violet-300 underline" href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">elevenlabs.io → API keys</a>
          with Music and Sound Effects access. It's stored on this computer in <code class="font-mono">~/.storyboard</code> and never sent to the browser or to Claude.
        </p>
        <div class="mt-3 flex gap-2">
          <input
            type="password"
            autocomplete="off"
            class="h-9 min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 font-mono outline-none focus:border-spindle/50"
            placeholder="sk_…"
            bind:value={keyInput}
            onkeydown={(e) => e.key === 'Enter' && keyInput.trim() && saveKey()}
          />
          <button class="rounded-lg bg-spindle px-4 font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40" disabled={!keyInput.trim() || busy === 'key'} onclick={() => saveKey()}>Save key</button>
          {#if changingKey}<button class="rounded-lg px-3 font-medium text-fg-soft hover:bg-raised" onclick={() => (changingKey = false)}>Cancel</button>{/if}
        </div>
      </div>
    {:else}
      <div class="flex items-center gap-2 text-[12px] text-muted">
        <Check size={13} class="text-emerald-300" />ElevenLabs connected{status.key.source === 'env' ? ' (ELEVENLABS_API_KEY)' : ''}
        {#if status.key.source === 'file'}
          · <button class="font-medium text-fg-soft hover:underline" onclick={() => (changingKey = true)}>Change key</button>
          · <button class="font-medium text-fg-soft hover:underline" onclick={() => confirm('Remove the saved ElevenLabs key?') && saveKey(true)}>Remove</button>
        {/if}
      </div>
    {/if}

    <div>
      <div class="mb-2 flex items-center justify-between">
        <h3 class="font-medium text-fg-soft">Direction</h3>
        <div class="flex gap-1">
          {#each MOODS as [id, label]}
            <button class="rounded-md px-2.5 py-1 font-medium transition {plan.mood === id ? 'bg-fg text-ink' : 'text-fg-soft hover:bg-raised'}" onclick={() => chooseMood(id)}>{label}</button>
          {/each}
        </div>
      </div>
      <div class="grid grid-cols-[1fr_220px] gap-2">
        <label class="block">
          <span class="mb-1 block text-[12px] text-muted">Styles for the whole track</span>
          <textarea
            rows="2"
            class="w-full resize-none rounded-lg border border-line px-3 py-2 leading-snug outline-none focus:border-spindle/50"
            value={join(plan.styles)}
            oninput={(e) => {
              plan!.styles = list(e.currentTarget.value);
              dirty = true;
            }}
          ></textarea>
        </label>
        <label class="block">
          <span class="mb-1 block text-[12px] text-muted">Avoid</span>
          <textarea
            rows="2"
            class="w-full resize-none rounded-lg border border-line px-3 py-2 leading-snug outline-none focus:border-spindle/50"
            value={join(plan.avoid)}
            oninput={(e) => {
              plan!.avoid = list(e.currentTarget.value);
              dirty = true;
            }}
          ></textarea>
        </label>
      </div>
    </div>

    <div>
      <h3 class="mb-2 font-medium text-fg-soft">Sections <span class="font-normal text-faint">· lengths follow the scenes, so the music changes on the cuts</span></h3>
      <div class="divide-y divide-line/60 rounded-xl border border-line">
        {#each timedSections as timed}
          {@const section = plan.sections[timed.index]}
          <div class="grid grid-cols-[150px_1fr] gap-3 px-3 py-2.5">
            <div>
              {#if section}
                <input
                  class="w-full rounded px-1 font-semibold outline-none hover:bg-raised focus:bg-raised"
                  value={section.label}
                  oninput={(e) => {
                    section.label = e.currentTarget.value;
                    dirty = true;
                  }}
                />
              {:else}<span class="px-1 font-semibold">{timed.label}</span>{/if}
              <div class="px-1 font-mono text-[11px] text-faint">{timed.start.toFixed(2)}–{(timed.start + timed.duration).toFixed(2)}s</div>
              <div class="truncate px-1 text-[11px] text-muted" title={timed.scenes.map(sceneTitle).join(', ')}>{timed.scenes.map(sceneTitle).join(', ')}</div>
            </div>
            {#if section}
              <div class="space-y-1.5">
                <input
                  class="w-full rounded-md border border-line px-2.5 py-1.5 outline-none focus:border-spindle/50"
                  placeholder="What happens musically, e.g. [Build] &#123;pulse enters, pads open up&#125;"
                  value={(section.text ?? '').replace(/\n/g, ' ')}
                  oninput={(e) => {
                    section.text = e.currentTarget.value.replace(/^(\[[^\]]+\])\s*/, '$1\n');
                    dirty = true;
                  }}
                />
                <input
                  class="w-full rounded-md border border-line px-2.5 py-1.5 text-fg-soft outline-none focus:border-spindle/50"
                  placeholder="Section styles, comma separated"
                  value={join(section.styles)}
                  oninput={(e) => {
                    section.styles = list(e.currentTarget.value);
                    dirty = true;
                  }}
                />
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-fg-soft">
      <label class="flex items-center gap-2">
        Model
        <select
          class="h-8 rounded-md border border-line bg-panel px-2 outline-none"
          value={plan.model}
          onchange={(e) => {
            plan!.model = e.currentTarget.value as MusicPlan['model'];
            dirty = true;
          }}
        >
          <option value="music_v2_5">Music v2.5 (best sound)</option>
          <option value="music_v2">Music v2</option>
          <option value="music_v1">Music v1 (exact section timing)</option>
        </select>
      </label>


    </div>

    <div class="flex items-center gap-3">
      <p class="flex-1 text-[12px] text-muted">
        {status.seconds.toFixed(1)}s of music. Each generation uses ElevenLabs credits. Sound effects are set up per scene in the Sound tab.
      </p>
      <button class="rounded-lg px-3 py-2 font-medium text-fg-soft hover:bg-raised disabled:opacity-40" disabled={!dirty || !!busy} onclick={save}>Save direction</button>
      <button
        class="flex items-center gap-2 rounded-lg bg-spindle px-4 py-2 text-[14px] font-semibold text-ink hover:bg-spindle-hover disabled:opacity-40"
        disabled={!status.key.configured || generating}
        onclick={generate}
      >
        {#if busy === 'generate'}<span class="size-3.5 animate-spin rounded-full border-2 border-ink/30 border-t-ink"></span>Generating…{:else}<WandSparkles size={15} />{status.takes.length ? 'Generate new take' : 'Generate music'}{/if}
      </button>
    </div>

    {#if generating && store.score.message}
      <div class="flex items-center gap-2 rounded-lg bg-violet-400/10 px-3 py-2 text-violet-300">
        <span class="size-3 animate-spin rounded-full border-2 border-violet-400/25 border-t-violet-300"></span>{store.score.message}
      </div>
    {/if}
    {#if result && !generating}
      <div class="rounded-lg bg-raised p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-soft">{result.summary}{#if result.warnings.length}{'\n\n'}⚠ {result.warnings.join('\n⚠ ')}{/if}</div>
    {/if}
    {#if status.timingChanged}
      <div class="rounded-lg bg-amber-300/10 px-3 py-2 text-amber-300">Scene timing changed since this take was generated, so its sections no longer line up with the cuts. Generate a new take to re-align them.</div>
    {/if}

    {#if status.takes.length}
      <div>
        <h3 class="mb-2 font-medium text-fg-soft">Takes</h3>
        <div class="space-y-1.5">
          {#each status.takes as take, i}
            {@const current = take.id === status.currentTake}
            <div class="flex items-center gap-3 rounded-lg border px-3 py-2 {current ? 'border-violet-400/50 bg-violet-400/10' : 'border-line'}">
              <div class="w-28 shrink-0">
                <div class="font-medium">Take {status.takes.length - i}{take.mood ? ` · ${take.mood}` : ''}</div>
                <div class="text-[11px] text-faint">{fmt(take.createdAt)} · ~{Math.round(take.bpm)} BPM</div>
              </div>
              <!-- svelte-ignore a11y_media_has_caption -->
              <audio controls preload="none" src="/p/{slug}/{take.file}" class="h-8 min-w-0 flex-1"></audio>
              {#if current}
                <span class="rounded-full bg-violet-600 px-2 py-0.5 text-[11px] font-semibold text-white">In use</span>
              {:else}
                <button class="rounded-md border border-line px-2.5 py-1 font-medium hover:bg-raised disabled:opacity-40" disabled={generating} onclick={() => use(take.id)}>Use</button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="flex gap-2">
      <input
        class="h-9 min-w-0 flex-1 rounded-lg border border-line px-3 outline-none focus:border-spindle/50"
        placeholder="Ask Claude to write the direction, e.g. warm and hopeful, build into the anatomy reveal"
        bind:value={request}
        onkeydown={(e) => e.key === 'Enter' && askClaude()}
      />
      <button class="flex items-center gap-1.5 rounded-lg border border-line px-3 font-medium hover:bg-raised disabled:opacity-40" onclick={askClaude} disabled={!request.trim()}><Sparkles size={14} />Ask</button>
    </div>
  </div>
{:else}
  <div class="grid h-40 place-items-center"><span class="size-4 animate-spin rounded-full border-2 border-line-strong border-t-fg"></span></div>
{/if}
