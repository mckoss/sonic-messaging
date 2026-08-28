import { writable } from 'svelte/store';

/**
 * How far back from live the receiver waterfalls are scrubbed, in captured samples.
 * Shared so dragging any lane scrubs every lane together; 0 means live.
 */
export const waterfallScrubSamples = writable(0);

/** The symbol waterfall's live-edge sample position and viewport width in samples. */
export const waterfallView = writable({ position: -1, viewSamples: 0 });
