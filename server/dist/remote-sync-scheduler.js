/**
 * Node timers clamp delays greater than a signed 32-bit integer to 1 ms.
 * Keep the configured unit in minutes and cap it before converting to ms.
 */
export const MAX_SYNC_INTERVAL_MINUTES = Math.floor(0x7fff_ffff / 60_000);
/**
 * Schedules remote catalog synchronization without coupling the timer policy to
 * the catalog implementations.  A zero interval deliberately performs no work
 * at startup; settings changes still get one immediate refresh for feedback.
 */
export class RemoteSyncScheduler {
    options;
    timer;
    constructor(options) {
        this.options = options;
    }
    start() {
        if (this.resetTimer())
            this.trigger();
    }
    /** Reconfigure the timer and immediately refresh after a user setting change. */
    refreshAfterSettingsChange() {
        this.resetTimer();
        this.trigger();
    }
    stop() {
        if (!this.timer)
            return;
        (this.options.clearIntervalImpl ?? clearInterval)(this.timer);
        this.timer = undefined;
    }
    resetTimer() {
        this.stop();
        const configuredMinutes = this.options.getIntervalMinutes();
        if (!Number.isSafeInteger(configuredMinutes) || configuredMinutes <= 0)
            return false;
        // Validation prevents this in normal operation.  The defensive clamp also
        // protects a malformed legacy settings file from becoming a 1 ms interval.
        const intervalMinutes = Math.min(configuredMinutes, MAX_SYNC_INTERVAL_MINUTES);
        const timer = (this.options.setIntervalImpl ?? setInterval)(() => this.trigger(), intervalMinutes * 60_000);
        timer.unref?.();
        this.timer = timer;
        return true;
    }
    trigger() {
        void this.options.sync().catch(() => undefined);
    }
}
