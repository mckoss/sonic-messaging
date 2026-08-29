<script lang="ts">
  import { fskCenterFrequency, fskFrequencies, fskPlanWarnings, fskSuggestedPlan, fskToneSpan } from '../dsp/fsk-frequencies';
  import { dsssCodeLengths, normalizeDsssCodeLength } from '../dsp/dsss-code-options';

  type Mode = 'FSK' | 'CSS' | 'DSSS';
  export let mode: Mode;
  export let settings: Record<string, number | string | boolean>;

  $: centerFrequency = Number(settings.centerFrequency);
  $: fskTones = mode === 'FSK'
    ? fskFrequencies(Number(settings.lowestFrequency), Number(settings.toneSpacing), Number(settings.tones))
    : [];
  $: toneSpacing = Number(settings.toneSpacing);
  $: fskSpan = mode === 'FSK' ? fskToneSpan(toneSpacing, Number(settings.tones)) : 0;
  $: fskCenter = mode === 'FSK'
    ? fskCenterFrequency(Number(settings.lowestFrequency), toneSpacing, Number(settings.tones))
    : 0;
  $: spacingRatio = mode === 'FSK' ? toneSpacing / Number(settings.symbolRate) : 0;
  // Whole tone cycles integrated per symbol slot, for the lowest and highest tones.
  $: fskCyclesLow = fskTones.length ? fskTones[0] / Number(settings.symbolRate) : 0;
  $: fskCyclesHigh = fskTones.length ? fskTones[fskTones.length - 1] / Number(settings.symbolRate) : 0;
  $: fskBitsPerSecond = mode === 'FSK' ? Number(settings.symbolRate) * Math.log2(Number(settings.tones)) : 0;
  $: fskWarnings = mode === 'FSK' ? fskPlanWarnings(fskTones, toneSpacing, Number(settings.symbolRate)) : [];
  $: fskSuggestion = mode === 'FSK' ? fskSuggestedPlan(Number(settings.symbolRate), Number(settings.tones)) : undefined;
  $: fskSuggestionDiffers = !!fskSuggestion && fskWarnings.length > 0 &&
    (Number(settings.lowestFrequency) !== fskSuggestion.lowestFrequency || toneSpacing !== fskSuggestion.toneSpacing);

  function applyFskSuggestion(event: MouseEvent) {
    if (!fskSuggestion) return;
    settings.lowestFrequency = fskSuggestion.lowestFrequency;
    settings.toneSpacing = fskSuggestion.toneSpacing;
    // Bubble a change event so the host persists settings and reconfigures the detector.
    (event.currentTarget as HTMLElement).dispatchEvent(new Event('change', { bubbles: true }));
  }
  $: chipRate = Number(settings.chipRate);
  $: dsssLengths = dsssCodeLengths(String(settings.codeFamily));
  $: if (mode === 'DSSS') settings.codeLength = normalizeDsssCodeLength(
    String(settings.codeFamily), Number(settings.codeLength)
  );

  function hz(value: number): string {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} Hz`;
  }
</script>

<div class="controls-grid">
  {#if mode !== 'FSK'}
    <label>
      <span>Center frequency <output>{Number(settings.centerFrequency).toLocaleString()} Hz</output></span>
      <input type="range" min="1000" max="20000" step="100" bind:value={settings.centerFrequency} />
    </label>
  {/if}

  {#if mode === 'FSK'}
    <label><span>Lowest frequency</span><input type="number" min="100" max="23000" step="100" bind:value={settings.lowestFrequency} /><small>Hz</small></label>
    <label><span>Tone spacing</span><input type="number" min="10" max="12000" step="10" bind:value={settings.toneSpacing} /><small>Hz</small></label>
    <label><span>Tones</span><select bind:value={settings.tones}><option value={2}>2-FSK</option><option value={4}>4-FSK</option><option value={8}>8-FSK</option><option value={16}>16-FSK</option></select></label>
    <label><span>Symbol rate</span><input type="number" min="5" max="2000" bind:value={settings.symbolRate} /><small>baud</small></label>
    <div class="frequency-plan" aria-live="polite">
      <strong>Generated tones</strong>
      <span>{fskTones.map(hz).join(' · ')}</span>
      <span class="detail">Center {hz(fskCenter)} · span {hz(fskSpan)} · spacing/rate {spacingRatio.toLocaleString(undefined, { maximumFractionDigits: 2 })} · <span data-testid="fsk-bit-rate">{fskBitsPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 })} bps</span> · <span data-testid="fsk-cycles-per-symbol">{fskCyclesLow.toLocaleString(undefined, { maximumFractionDigits: 1 })}–{fskCyclesHigh.toLocaleString(undefined, { maximumFractionDigits: 1 })} cycles/symbol</span></span>
      {#each fskWarnings as warning}<span class="warning">⚠ {warning}</span>{/each}
      {#if fskSuggestion && fskSuggestionDiffers}
        <button type="button" class="suggestion" on:click={applyFskSuggestion}>
          Use suggested plan for {Number(settings.symbolRate).toLocaleString()} baud: lowest {fskSuggestion.lowestFrequency.toLocaleString()} Hz · spacing {fskSuggestion.toneSpacing.toLocaleString()} Hz
        </button>
      {/if}
    </div>
  {:else if mode === 'CSS'}
    <label>
      <span>Sweep bandwidth <output>{Number(settings.bandwidth).toLocaleString()} Hz</output></span>
      <input type="range" min="200" max="12000" step="100" bind:value={settings.bandwidth} />
    </label>
    <label><span>Spreading factor</span><select bind:value={settings.spreadingFactor}>{#each [5,6,7,8,9,10,11,12] as sf}<option value={sf}>SF{sf}</option>{/each}</select></label>
    <label><span>Chirp direction</span><select bind:value={settings.chirpDirection}><option>Up</option><option>Down</option><option>Alternating</option></select></label>
    <label><span>Preamble</span><input type="number" min="4" max="32" bind:value={settings.preambleSymbols} /><small>symbols</small></label>
  {:else}
    <label><span>Code family</span><select bind:value={settings.codeFamily}><option>Gold</option><option>Kasami</option><option>m-sequence</option><option>Barker</option></select></label>
    <label><span>Code length</span><select bind:value={settings.codeLength}>{#each dsssLengths as n}<option value={n}>{n} chips</option>{/each}</select></label>
    <label><span>Code index</span><input type="number" min="0" max="1024" bind:value={settings.codeIndex} /></label>
    <label><span>Chip rate</span><input type="number" min="100" max="24000" step="100" bind:value={settings.chipRate} /><small>chips/s</small></label>
    <div class="frequency-plan">
      <strong>Estimated occupied spectrum</strong>
      <span>{hz(centerFrequency - chipRate)}–{hz(centerFrequency + chipRate)}</span>
      <span class="detail">Approximate rectangular-chip BPSK main lobe (first nulls); actual sidelobes extend beyond it.</span>
    </div>
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
  .frequency-plan { grid-column: 1 / -1; display: grid; gap: 5px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 9px; background: color-mix(in srgb, var(--field) 72%, transparent); color: var(--text); font: 12px ui-monospace, monospace; overflow-wrap: anywhere; }
  .frequency-plan strong { color: var(--muted); font: 650 12px system-ui, sans-serif; }
  .frequency-plan .detail { color: var(--dim); font: 12px system-ui, sans-serif; }
  .frequency-plan .warning { color: #f5c46b; font: 12px/1.4 system-ui, sans-serif; }
  .suggestion { justify-self: start; margin-top: 3px; border: 1px solid #2c8e6f; border-radius: 7px; padding: 6px 10px; background: #0b2c22; color: #4ee8b4; font: 600 11px system-ui, sans-serif; cursor: pointer; text-align: left; }
  @media (max-width: 620px) { .controls-grid { grid-template-columns: 1fr; } }
</style>
