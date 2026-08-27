<script lang="ts">
  import { onMount } from 'svelte';

  export let spectrum: number[] | Float32Array = [];
  export let sampleRate = 48_000;
  export let minFrequency = 0;
  export let maxFrequency = 24_000;
  export let label = 'Live receiver spectrum';

  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let width = 800;
  let height = 220;

  function draw() {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, width * ratio);
    canvas.height = Math.max(1, height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#101d31');
    gradient.addColorStop(1, '#07101d');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(148, 163, 184, .13)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = (i / 8) * width;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let i = 1; i < 4; i++) {
      const y = (i / 4) * height;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    const bins = spectrum.length ? spectrum : new Float32Array(256).fill(-110);
    const nyquist = sampleRate / 2;
    const start = Math.max(0, Math.floor((minFrequency / nyquist) * bins.length));
    const end = Math.min(bins.length, Math.ceil((maxFrequency / nyquist) * bins.length));
    ctx.beginPath();
    for (let i = start; i < end; i++) {
      const db = Number.isFinite(bins[i]) ? bins[i] : -110;
      const x = ((i - start) / Math.max(1, end - start - 1)) * width;
      const y = height - Math.max(0, Math.min(1, (db + 110) / 110)) * height;
      if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#4ee8b4';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#4ee8b4';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
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

<div class="spectrum" bind:this={host} aria-label={label} role="img">
  <canvas bind:this={canvas}></canvas>
  <span class="axis left">{Math.round(minFrequency / 100) / 10} kHz</span>
  <span class="axis right">{Math.round(maxFrequency / 100) / 10} kHz</span>
  <span class="db">0 dB</span>
</div>

<style>
  .spectrum { position: relative; width: 100%; min-height: 176px; overflow: hidden; border-radius: 14px; }
  canvas { display: block; width: 100%; height: auto; }
  .axis, .db { position: absolute; color: #8ea0b8; font: 11px/1.2 ui-monospace, monospace; pointer-events: none; }
  .left { bottom: 9px; left: 10px; } .right { bottom: 9px; right: 10px; } .db { top: 9px; right: 10px; }
</style>
