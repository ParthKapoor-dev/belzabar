// Polling / timeout defaults for the Jenkins client.

export const QUEUE_POLL_INTERVAL_MS = 2000;
export const CONSOLE_POLL_INTERVAL_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
/** How long `resolveQueueItem` waits for a queued build to get an executor (MG-5). */
export const QUEUE_TIMEOUT_MS = 10 * 60 * 1000;
