<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import type { ChatMessage } from '../../shared/types';
  import { markdown } from '../lib/markdown';
  import { store } from '../lib/store.svelte';

  let { message }: { message: ChatMessage } = $props();

  let now = $state(Date.now());
  let expanded = $state(false);

  $effect(() => {
    if (message.status !== 'running') return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const seconds = $derived(Math.round(((message.status === 'running' ? now : message.createdAt + (message.durationMs ?? 0)) - message.createdAt) / 1000));
  const steps = $derived(message.activity ?? []);
  const recent = $derived(steps.slice(-4));
</script>

{#if message.role === 'user'}
  <div class="flex flex-col items-end gap-1.5">
    {#if message.attachments?.length}
      <div class="flex flex-wrap justify-end gap-1.5">
        {#each message.attachments as file}
          <img src="/p/{store.project?.slug}/{file}" alt="" class="h-16 rounded-md object-cover ring-1 ring-line" />
        {/each}
      </div>
    {/if}
    <div class="max-w-[88%] rounded-2xl rounded-br-md bg-line px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-fg">
      {message.text}
    </div>
    {#if message.playhead !== undefined}
      <span class="tabular font-mono text-[11px] text-faint">at {message.playhead.toFixed(2)}s</span>
    {/if}
  </div>
{:else}
  <div class="max-w-[94%] rounded-2xl bg-raised px-4 py-3">
    {#if message.status === 'running'}
      <div class="mb-1 flex items-center gap-2 text-[13px] font-medium text-fg-soft">
        <span class="size-3 animate-spin rounded-full border-2 border-line-strong border-t-fg"></span>
        Working · {seconds}s
      </div>
      {#if steps.length > recent.length}
        <div class="pl-5 text-[12px] text-faint">{steps.length - recent.length} earlier steps</div>
      {/if}
      <ul class="space-y-0.5 pl-5">
        {#each recent as step}
          <li class="truncate text-[12.5px] {step.kind === 'note' ? 'text-fg-soft italic' : 'font-mono text-muted'}" title={step.label}>
            {step.label}
          </li>
        {/each}
      </ul>
      {#if message.text}
        <div class="prose-chat mt-2 text-[14.5px] leading-relaxed text-fg">{@html markdown(message.text)}</div>
      {/if}
    {:else}
      {#if steps.length}
        <button class="mb-1.5 flex items-center gap-1 text-[12px] font-medium text-muted hover:text-fg" onclick={() => (expanded = !expanded)}>
          <ChevronRight size={13} class="transition {expanded ? 'rotate-90' : ''}" />
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </button>
        {#if expanded}
          <ul class="mb-2 space-y-0.5 border-l border-line-strong pl-3">
            {#each steps as step}
              <li class="text-[12.5px] break-words {step.kind === 'note' ? 'text-fg-soft italic' : 'font-mono text-muted'}">{step.label}</li>
            {/each}
          </ul>
        {/if}
      {/if}
      <div class="prose-chat text-[14.5px] leading-relaxed {message.status === 'error' ? 'text-red-400' : 'text-fg'}">
        {@html markdown(message.text || (message.status === 'stopped' ? '_Stopped._' : ''))}
      </div>
      <div class="mt-1.5 flex gap-2 font-mono text-[11px] text-faint">
        <span>{seconds}s</span>
        {#if message.status === 'stopped'}<span>stopped</span>{/if}
        {#if message.costUsd}<span>${message.costUsd.toFixed(2)}</span>{/if}
      </div>
    {/if}
  </div>
{/if}
