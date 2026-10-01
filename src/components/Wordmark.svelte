<script lang="ts">
  // "spindle/story": the Spindle wordmark with the product after the slash.
  // The slash takes the brand green, the way the full stop does in the Spindle logo.
  let { size = 18, signed = false }: { size?: number; signed?: boolean } = $props();
</script>

<span class="relative inline-flex flex-col items-end" style="font-size:{size}px">
  <span class="wordmark pr-[0.09em] whitespace-nowrap"><span class="text-fg">spindle</span><span class="text-spindle">/</span><span class="text-fg">story</span></span>
  {#if signed}
    <span class="signature -mt-[0.05em] mr-[-0.2em] text-[0.52em] text-spindle">by jsj</span>
  {/if}
</span>
