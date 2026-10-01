<script lang="ts">
  import { X } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  let {
    title,
    subtitle,
    width = 560,
    onclose,
    children,
    footer,
  }: { title: string; subtitle?: string; width?: number; onclose: () => void; children: Snippet; footer?: Snippet } = $props();

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 pt-[8vh] backdrop-blur-[2px]">
  <button class="fixed inset-0 cursor-default" aria-label="Close" onclick={onclose}></button>
  <div class="relative flex max-h-[84vh] w-full flex-col rounded-2xl bg-panel shadow-2xl ring-1 ring-line" style="max-width:{width}px">
    <header class="flex items-start gap-4 px-6 pt-5 pb-4">
      <div class="min-w-0 flex-1">
        <h2 class="text-[17px] font-semibold tracking-tight">{title}</h2>
        {#if subtitle}<p class="mt-0.5 text-[13px] text-muted">{subtitle}</p>{/if}
      </div>
      <button class="-mr-2 grid size-8 place-items-center rounded-md text-faint hover:bg-raised hover:text-fg" onclick={onclose}>
        <X size={17} />
      </button>
    </header>
    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 pb-5">
      {@render children()}
    </div>
    {#if footer}
      <footer class="flex items-center justify-end gap-2 border-t border-line/60 px-6 py-3.5">
        {@render footer()}
      </footer>
    {/if}
  </div>
</div>
