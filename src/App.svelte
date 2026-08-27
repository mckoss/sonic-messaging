<script lang="ts">
  let ready = false;
</script>

<main>
  <h1>Sonic Lab</h1>
  <p>{ready ? 'Audio ready' : 'Modulation test bed loading…'}</p>
  <button onclick={() => (ready = true)}>Initialize</button>
</main>
