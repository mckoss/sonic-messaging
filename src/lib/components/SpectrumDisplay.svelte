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

    const rowHeight = Math.max(1, Math.round(ratio));
    if (pixelHeight > rowHeight) {
      ctx.drawImage(canvas, 0, rowHeight, pixelWidth, pixelHeight - rowHeight, 0, 0, pixelWidth, pixelHeight - rowHeight);
    }

    const { start, end } = frequencyBinRange(spectrum.length, sampleRate, minFrequency, maxFrequency);
    const span = end - start;
    const row = ctx.createImageData(pixelWidth, rowHeight);
    for (let x = 0; x < pixelWidth; x++) {
      const binStart = start + Math.floor((x / pixelWidth) * span);
      const binEnd = Math.max(binStart + 1, start + Math.ceil(((x + 1) / pixelWidth) * span));
      let peakDb = -110;
      for (let bin = binStart; bin < Math.min(end, binEnd); bin++) {
        const value = spectrum[bin];
        if (Number.isFinite(value)) peakDb = Math.max(peakDb, value);
      }
      const [red, green, blue] = intensityToRgb(dbToIntensity(peakDb));
      for (let y = 0; y < rowHeight; y++) {
        const offset = (y * pixelWidth + x) * 4;
        row.data[offset] = red;
        row.data[offset + 1] = green;
        row.data[offset + 2] = blue;
        row.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(row, 0, pixelHeight - rowHeight);
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

<div class="spectrum" bind:this={host} aria-label={`${label}; waterfall display, newest samples at bottom`} role="img">
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
  <span class="axis left">{Math.round(minFrequency / 100) / 10} kHz</span>
  <span class="axis right">{Math.round(maxFrequency / 100) / 10} kHz</span>
  <span class="time">older ↑ · newest ↓</span>
</div>

<style>
  .spectrum { position: relative; width: 100%; min-height: 176px; overflow: hidden; border-radius: 14px; background: #050a18; }
  canvas { display: block; width: 100%; height: 220px; }
  .axis, .time { position: absolute; color: #c3cfdd; font: 11px/1.2 ui-monospace, monospace; pointer-events: none; text-shadow: 0 1px 3px #050a18, 0 0 3px #050a18; }
  .left { bottom: 9px; left: 10px; }
  .right { bottom: 9px; right: 10px; }
  .time { top: 9px; right: 10px; }
  @media (max-width: 559px) { canvas { height: 176px; } }
</style>
