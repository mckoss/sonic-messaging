/**
 * This device's frame sender ID: a random 16-bit number chosen once per app launch, like a source address.
 * Pass it to workers explicitly; a worker importing this module would draw a different ID.
 */
export const DEVICE_SENDER = crypto.getRandomValues(new Uint16Array(1))[0];
