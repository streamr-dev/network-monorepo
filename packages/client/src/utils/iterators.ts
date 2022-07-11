import Emitter from 'events'
import pMemoize from 'p-memoize'
import { MaybeAsync } from '../types'

import { AggregatedError } from './AggregatedError'
import { pTimeout } from './promises'
import { Defer } from './Defer'
import { Debug } from './log'

export const debug = Debug('iterators')

export type ICancelable = {
    cancel(err?: Error): Promise<void>
    isCancelled: () => boolean
}

export type Cancelable<T> = T & ICancelable

export type MaybeCancelable<T> = T | Cancelable<T>

/**
 * Allows injecting a function to execute after an iterator finishes.
 * Executes finally function even if generator not started.
 * Returns new generator.
 */
type OnFinallyFn = MaybeAsync<(err?: Error) => void>

export function iteratorFinally<T>( // eslint-disable-line no-redeclare
    iterable: MaybeCancelable<AsyncIterable<T> | AsyncGenerator<T>>,
    onFinally?: OnFinallyFn
): AsyncGenerator<T, any, unknown> {
    if (!onFinally) {
        // noop if no onFinally
        return (async function* Noop() {
            yield* iterable
        }())
    }

    let started = false
    let ended = false
    let error: Error | undefined
    let onFinallyTask: Promise<void> | undefined
    // ensure finally only runs once
    let onFinallyOnce: OnFinallyFn = (err?: Error) => {
        if (!onFinallyTask) {
            // eslint-disable-next-line promise/no-promise-in-callback
            onFinallyTask = Promise.resolve(onFinally(err)).finally(() => {
                onFinallyOnce = () => {}
            })
        }
        return onFinallyTask
    }

    // wraps return/throw to call onFinally even if generator was never started
    function handleFinally<ArgsType extends any[], ReturnType>(originalFn: (...args: ArgsType) => PromiseLike<ReturnType>) {
        return async (...args: ArgsType) => {
            // * only await onFinally if not started
            // * call original return/throw *immediately* in either case
            // Otherwise:
            // * if started, iterator won't stop until onFinally finishes
            // * if not started, iterator can still be started before onFinally finishes
            // This function handles both cases, but note here as a reminder.
            ended = true
            if (started) {
                return originalFn(...args)
            }

            // otherwise iteration can still start if finally function still pending
            try {
                return await originalFn(...args)
            } catch (err) {
                if (!error) {
                    error = err
                }
                throw err
            } finally {
                await onFinallyOnce(error)
            }
        }
    }

    // wrap in generator to track if generator was started
    const gen = (async function* TrackStarted() {
        started = true
        try {
            yield* iterable
        } catch (err) {
            if (!error) {
                error = err
            }
            throw err
        } finally {
            await onFinallyOnce(error)
        }
    }())

    const it = gen[Symbol.asyncIterator].bind(gen)
    let g: MaybeCancelable<AsyncGenerator>
    // copy cancel api across if exists
    if ('cancel' in iterable) {
        g = Object.assign(gen, {
            cancel: (err?: Error) => iterable.cancel(err),
            isCancelled: () => iterable.isCancelled()
        })
    } else {
        g = gen
    }

    // replace generator methods
    return Object.assign(g, {
        return: handleFinally(g.return.bind(g)),
        throw: handleFinally(g.throw.bind(g)),
        [Symbol.asyncIterator]() {
            // if ended before started
            if (ended && !started) {
                // return a generator that simply runs finally script (once)
                return (async function* generatorRunFinally() { // eslint-disable-line require-yield
                    try {
                        // NOTE: native generators do not throw if gen.throw(err) called before started
                        // so we should do the same here
                        if ('return' in iterable) {
                            await iterable.return(undefined) // runs onFinally for nested iterable
                        }
                    } finally {
                        await onFinallyOnce()
                    }
                }())
            }

            return it()
        }
    }) as (
        typeof iterable extends Cancelable<typeof iterable>
            ? Cancelable<AsyncGenerator<T>>
            : AsyncGenerator<T>
    )
}

async function endGenerator(gtr: AsyncGenerator, error?: Error) {
    return error
        ? gtr.throw(error).catch(() => {}) // ignore err
        : gtr.return(undefined)
}

function canCancel<T>(gtr: MaybeCancelable<T>): gtr is Cancelable<T> {
    return (
        gtr
        && 'cancel' in gtr && typeof gtr.cancel === 'function'
        && typeof gtr.isCancelled === 'function'
        && !gtr.isCancelled()
    )
}

async function cancelGenerator<T>(gtr: MaybeCancelable<T>, error?: Error) {
    if (!canCancel(gtr)) { return }
    await gtr.cancel(error)
}

const endGeneratorTimeout = pMemoize(async (gtr, error, timeout = 250) => {
    await pTimeout(endGenerator(gtr, error), {
        timeout,
        rejectOnTimeout: false,
    })

    if (canCancel(gtr)) {
        await cancelGenerator(gtr, error)
    }
}, {
    cache: new WeakMap(),
    cachePromiseRejection: true,
})

/**
 * Creates a generator that can be cancelled and perform optional final cleanup.
 * const [cancal, generator] = CancelableGenerator(iterable, onFinally)
 */
export function CancelableGenerator<T>(
    iterable: MaybeCancelable<AsyncIterable<T> | AsyncGenerator<T>>,
    onFinally: OnFinallyFn = () => {},
    { timeout = 250 } = {}
): Cancelable<AsyncGenerator<T, any, unknown>> {
    let cancelled = false
    let finalCalled = false
    let error: Error | AggregatedError | undefined

    const cancelSignal = new Emitter()
    const onDone = Defer()

    let iterator: AsyncIterator<T>

    async function cancelIterable(err?: Error) {
        // cancel inner if has cancel
        await cancelGenerator(iterable, err)
        await cancelGenerator(iterator, err)
    }

    function collectErrors(value?: Error | AggregatedError) {
        if (!value || value === error) { return }

        if (!error) {
            error = value
            return
        }

        error = 'extend' in error
            ? error.extend(value, value.message)
            : new AggregatedError([value, error], value.message)
    }

    function resolveCancel(value?: Error) {
        if (value instanceof Error) {
            collectErrors(value)
        }

        if (error) {
            cancelSignal.emit('cancel', error)
        } else {
            cancelSignal.emit('cancel', value)
        }
    }

    const cancel = (gtr: MaybeCancelable<AsyncGenerator<T>>) => async (value: Error) => {
        if (cancelled || finalCalled) {
            // prevent recursion
            return onDone
        }

        cancelled = true
        resolveCancel(value)

        // need to make sure we don't try return inside final otherwise we end up deadlocked
        await endGeneratorTimeout(gtr, error, timeout)
        return onDone
    }

    let pendingNext = 0

    async function* CancelableGeneratorFn() {
        // manually iterate
        iterator = iterable[Symbol.asyncIterator]()

        try {
            yield* {
                // each next() races against cancel signal
                next: async () => {
                    pendingNext += 1
                    cancelSignal.setMaxListeners(pendingNext)
                    // NOTE:
                    // Very easy to create a memleak here.
                    // Using a shared promise with Promise.race
                    // between loop iterations prevents data from being GC'ed.
                    // Create new per-loop promise and resolve using an event emitter.
                    const cancelPromise = Defer<{ value: undefined, done: true }>()
                    const onCancel = (v?: Error) => {
                        if (v instanceof Error) {
                            cancelPromise.reject(v)
                        } else {
                            cancelPromise.resolve({ value: undefined, done: true })
                        }
                    }

                    cancelSignal.once('cancel', onCancel)
                    return Promise.race([
                        iterator.next(),
                        cancelPromise,
                    ]).finally(() => {
                        pendingNext -= 1
                        cancelSignal.setMaxListeners(pendingNext)
                        cancelSignal.off('cancel', onCancel)
                    })
                },
                async throw(err: Error): Promise<{ value: T, done: true }> {
                    cancelSignal.removeAllListeners()
                    await endGeneratorTimeout(iterator, err, timeout)
                    throw err
                },
                async return(v?: T) {
                    cancelSignal.removeAllListeners()
                    await endGeneratorTimeout(iterator, error, timeout)
                    return {
                        value: v,
                        done: true,
                    }
                },
                [Symbol.asyncIterator]() {
                    return this
                },
            }
        } finally {
            cancelSignal.removeAllListeners()
            // try end iterator
            if (iterator) {
                await endGeneratorTimeout(iterator, error, timeout)
            }
        }
    }
    const c = CancelableGeneratorFn()
    const cancelableGenerator = iteratorFinally(c, async (err) => {
        finalCalled = true
        try {
            // cancel inner if has cancel
            await cancelIterable(err || error)
            await onFinally(err || error)
        } finally {
            onDone.resolve(undefined)
        }

        // error whole generator, for await of will reject.
        if (error) {
            throw error
        }

        return onDone
    }) as AsyncGenerator<T>

    const cancelFn = cancel(cancelableGenerator)

    Object.assign(cancelableGenerator, {
        cancel: cancelFn,
        timeout,
        isCancelled: () => cancelled,
        isDone: () => finalCalled,
    })

    return cancelableGenerator as Cancelable<typeof cancelableGenerator>
}

export const nextValue = async <T>(source: AsyncIterator<T>): Promise<T | void> => {
    const item = source.next()
    return (await item).value
}

export const collect = async <T>(source: AsyncIterableIterator<T>, maxCount?: number): Promise<T[]> => {
    const items: T[] = []
    for await (const item of source) {
        items.push(item)
        if ((maxCount !== undefined) && (items.length >= maxCount)) {
            break
        }
    }
    return items
}
