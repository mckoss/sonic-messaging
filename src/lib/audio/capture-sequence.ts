/**
 * Continuity of the numbered chunks the capture AudioWorklet posts.
 *
 * The worklet stamps every chunk it sends with a counter that only increments (`capture.worklet.js`), one per render
 * quantum. The main thread forwards most of them, but when the DSP worker falls behind real time it stops posting
 * chunks *without* renumbering them, so a hole in the numbering is an exact record of audio that was thrown away.
 * Reading that hole is the only way the decoder learns its stream is not contiguous.
 */

/**
 * Samples missing between the expected chunk and the one that arrived: `undefined` when the stream is continuous (or
 * carries no numbering), a positive count when chunks were dropped, and `0` for a break whose length cannot be known.
 *
 * `chunkLength` stands in for the length of each missing chunk, which holds because Web Audio's render quantum is a
 * fixed 128 frames — every chunk is the same size as the one in hand. If that ever stops being true, the gap would be
 * mis-sized and every position reported afterwards would drift by the error.
 */
export function missingCaptureSamples(
  expected: number | undefined, received: number | undefined, chunkLength: number
): number | undefined {
  // Replay feeds slices that reuse one number, so there is no capture continuity to judge; nor is there on the very
  // first chunk, which may legitimately start at any number (a restarted worklet begins again at zero).
  if (received === undefined || expected === undefined || received === expected) return undefined;
  // Ahead of the expectation means chunks went missing, and how many is known exactly. Behind it means capture
  // restarted and renumbered: the stream is still broken here, but nothing says by how much.
  return received > expected ? (received - expected) * chunkLength : 0;
}
