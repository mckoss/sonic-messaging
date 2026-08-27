<script lang="ts">
  import { onMount } from 'svelte';
  import { dbToIntensity, frequencyBinRange, intensityToRgb } from '../audio/waterfall';

  export let spectrum: number[] | Float32Array = [];
  export let sampleRate = 48_000;
  export let minFrequency = 0;
  export let maxFrequency = 24_000;
  export let label = 'Live receiver spectrum';

  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let width = 800;
  let height = 220;
  let lastPixelWidth = 0;
  let lastPixelHeight = 0;

  function prepareCanvas(ctx: CanvasRenderingContext2D, pixelWidth: number, pixelHeight: number) {
    if (lastPixelWidth === pixelWidth && lastPixelHeight === pixelHeight) return;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    lastPixelWidth = pixelWidth;
    lastPixelHeight = pixelHeight;
    ctx.fillStyle = 'rgb(5, 10, 24)';
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
  }

  function draw() {
    if (!canvas || spectrum.length === 0) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    prepareCanvas(ctx, pixelWidth, pixelHeight);

    const columnWidth = Math.max(1, Math.round(ratio));
    if (pixelWidth > columnWidth) {
      ctx.drawImage(canvas, columnWidth, 0, pixelWidth - columnWidth, pixelHeight, 0, 0, pixelWidth - columnWidth, pixelHeight);
    }

    const { start, end } = frequencyBinRange(spectrum.length, sampleRate, minFrequency, maxFrequency);
    const span = end - start;
    const column = ctx.createImageData(columnWidth, pixelHeight);
    for (let y = 0; y < pixelHeight; y++) {
      const position = (pixelHeight - 1 - y) / pixelHeight;
      const binStart = start + Math.floor(position * span);
      const binEnd = Math.max(binStart + 1, start + Math.ceil((position + 1 / pixelHeight) * span));
      let peakDb = -110;
      for (let bin = binStart; bin < Math.min(end, binEnd); bin++) {
        const value = spectrum[bin];
        if (Number.isFinite(value)) peakDb = Math.max(peakDb, value);
      }
      const [red, green, blue] = intensityToRgb(dbToIntensity(peakDb));
      for (let x = 0; x < columnWidth; x++) {
        const offset = (y * columnWidth + x) * 4;
        column.data[offset] = red;
        column.data[offset + 1] = green;
        column.data[offset + 2] = blue;
        column.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(column, pixelWidth - columnWidth, 0);
  }

  $: spectrum, sampleRate, minFrequency, maxFrequency, width, height, draw();

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => {
      width = Math.max(280, Math.floor(entry.contentRect.width));
      height = width < 560 ? 176 : 220;
    });
    resize.observe(host);
    return () => resize.disconnect();
  });
</script>

<div class="figure" bind:this={host} aria-label={`${label}; waterfall display, newest samples at right`} role="img">
  <div class="time">older ← · newest →</div>
  <div class="plot"><div class="axis"><span>{Math.round(maxFrequency / 100) / 10} kHz</span><span>{Math.round(minFrequency / 100) / 10} kHz</span></div><div class="spectrum"><canvas bind:this={canvas} aria-hidden="true"></canvas></div></div>
</div>

<style>
  .figure { width: 100%; }
  .plot { display:grid; grid-template-columns:auto 1fr; gap:6px; }
  .spectrum { width: 100%; min-width:0; min-height:176px; overflow:hidden; border-radius:14px; background:#050a18; }
  canvas { display: block; width: 100%; height: 220px; }
  .axis, .time { color: #8294aa; font: 10px/1.2 ui-monospace, monospace; pointer-events: none; }
  .axis { display:flex; flex-direction:column; justify-content:space-between; padding:1px 0; text-align:right; }
  .time { height: 17px; padding-right: 2px; text-align: right; }
  @media (max-width: 559px) { canvas { height: 176px; } }
</style>
