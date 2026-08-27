<script lang="ts">
  type Mode = 'FSK' | 'CSS' | 'DSSS';
  export let mode: Mode;
  export let settings: Record<string, number | string | boolean>;
</script>

<div class="controls-grid">
  <label>
    <span>Center frequency <output>{Number(settings.centerFrequency).toLocaleString()} Hz</output></span>
    <input type="range" min="1000" max="20000" step="100" bind:value={settings.centerFrequency} />
  </label>

  <label>
    <span>Bandwidth <output>{Number(settings.bandwidth).toLocaleString()} Hz</output></span>
    <input type="range" min="200" max="12000" step="100" bind:value={settings.bandwidth} />
  </label>

  {#if mode === 'FSK'}
    <label><span>Tones</span><select bind:value={settings.tones}><option value={2}>2-FSK</option><option value={4}>4-FSK</option><option value={8}>8-FSK</option></select></label>
    <label><span>Symbol rate</span><input type="number" min="5" max="2000" bind:value={settings.symbolRate} /><small>baud</small></label>
    <label><span>Pulse shaping</span><select bind:value={settings.pulseShape}><option>Gaussian</option><option>Raised cosine</option><option>None</option></select></label>
  {:else if mode === 'CSS'}
    <label><span>Spreading factor</span><select bind:value={settings.spreadingFactor}>{#each [5,6,7,8,9,10,11,12] as sf}<option value={sf}>SF{sf}</option>{/each}</select></label>
    <label><span>Chirp direction</span><select bind:value={settings.chirpDirection}><option>Up</option><option>Down</option><option>Alternating</option></select></label>
    <label><span>Preamble</span><input type="number" min="4" max="32" bind:value={settings.preambleSymbols} /><small>symbols</small></label>
  {:else}
    <label><span>Code family</span><select bind:value={settings.codeFamily}><option>Gold</option><option>Kasami</option><option>m-sequence</option><option>Barker</option></select></label>
    <label><span>Code length</span><select bind:value={settings.codeLength}>{#each [31,63,127,255,511,1023] as n}<option value={n}>{n} chips</option>{/each}</select></label>
    <label><span>Code index</span><input type="number" min="0" max="1024" bind:value={settings.codeIndex} /></label>
    <label><span>Chip rate</span><input type="number" min="100" max="24000" step="100" bind:value={settings.chipRate} /><small>chips/s</small></label>
  {/if}
</div>

<style>
  .controls-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 20px; }
  label { display: grid; gap: 8px; position: relative; }
  label > span { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 13px; font-weight: 650; }
  output { color: var(--accent); font: 12px ui-monospace, monospace; }
  input[type='number'], select { width: 100%; box-sizing: border-box; color: var(--text); background: var(--field); border: 1px solid var(--line); border-radius: 9px; padding: 10px 11px; }
  input[type='range'] { width: 100%; accent-color: var(--accent); }
  small { position: absolute; right: 10px; bottom: 12px; color: var(--dim); pointer-events: none; }
  input[type='number'] { padding-right: 62px; }
  @media (max-width: 620px) { .controls-grid { grid-template-columns: 1fr; } }
</style>
