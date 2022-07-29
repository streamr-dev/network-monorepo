export class DebouncedTaskManager<K extends string> {
    private readonly tasks = new Map<K, NodeJS.Timeout>()

    schedule(key: K, timeoutInMs: number, task: (key: K) => void): void {
        const existingTimeoutRef = this.tasks.get(key)
        if (existingTimeoutRef !== undefined) {
            clearTimeout(existingTimeoutRef)
        }
        this.tasks.set(key, setTimeout(() => {
            this.tasks.delete(key)
            task(key)
        }, timeoutInMs))
    }

    unscheduleAll(): void {
        for (const timeoutRef of this.tasks.values()) {
            clearTimeout(timeoutRef)
        }
        this.tasks.clear()
    }
}
