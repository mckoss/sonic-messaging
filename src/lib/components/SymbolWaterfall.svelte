<script lang="ts">
  import { onMount } from 'svelte';
  import { intensityToRgb } from '../audio/waterfall';

  export let scores: Float32Array = new Float32Array();
  export let labels: string[] = [];
  export let sequence = -1;

  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let width = 800, height = 150, lastSequence = -1;

  function draw() {
    if (!canvas || !scores.length || sequence === lastSequence) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight;
      ctx.fillStyle = 'rgb(5, 10, 24)'; ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    }
    const rowHeight = Math.max(1, Math.round(2 * ratio));
    ctx.drawImage(canvas, 0, rowHeight, pixelWidth, pixelHeight - rowHeight, 0, 0, pixelWidth, pixelHeight - rowHeight);
    const row = ctx.createImageData(pixelWidth, rowHeight);
    for (let x = 0; x < pixelWidth; x++) {
      const symbol = Math.min(scores.length - 1, Math.floor(x * scores.length / pixelWidth));
      const [red, green, blue] = intensityToRgb(Math.sqrt(Math.max(0, Math.min(1, scores[symbol]))));
      for (let y = 0; y < rowHeight; y++) {
        const offset = (y * pixelWidth + x) * 4;
        row.data[offset] = red; row.data[offset + 1] = green; row.data[offset + 2] = blue; row.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(row, 0, pixelHeight - rowHeight);
    lastSequence = sequence;
  }

  $: scores, sequence, width, height, draw();

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => { width = Math.max(280, Math.floor(entry.contentRect.width)); });
    resize.observe(host);
    return () => resize.disconnect();
  });
</script>

<div class="figure" bind:this={host} aria-label="FSK symbol likelihood waterfall; newest detections at bottom" role="img">
  <div class="time">older ↑ · newest ↓</div>
  <div class="detector"><canvas bind:this={canvas} aria-hidden="true"></canvas></div>
  <div class="labels">{#each labels as label}<span>{label}</span>{/each}</div>
</div>

<style>
  .figure { width:100%; }
  .detector { width:100%; height:150px; overflow:hidden; border-radius:12px; background:#050a18; }
  canvas { display:block; width:100%; height:150px; }
  .labels { display:grid; grid-template-columns:repeat(auto-fit,minmax(1px,1fr)); padding-top:5px; color:#8294aa; font:10px ui-monospace,monospace; }
  .labels span { text-align:center; }
  .time { height:17px; padding-right:2px; color:#8294aa; font:10px ui-monospace,monospace; text-align:right; }
</style>
