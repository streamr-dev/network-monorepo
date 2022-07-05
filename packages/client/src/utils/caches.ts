import pMemoize from 'p-memoize'
import mem from 'mem'
import LRU from 'quick-lru'

type Collection<K, V> = {
    keys: Map<K, V>['keys']
    delete: Map<K, V>['delete']
}

function clearMatching<K>(cache: Collection<K, unknown>, matchFn: (key: K) => boolean): void {
    for (const key of cache.keys()) {
        if (matchFn(key)) {
            cache.delete(key)
        }
    }
}

/**
 * Returns a cached async fn, cached keyed on first argument passed. See documentation for mem/p-memoize.
 * Caches into a LRU cache capped at options.maxSize
 * Won't call asyncFn again until options.maxAge or options.maxSize exceeded, or cachedAsyncFn.clear() is called.
 * Won't cache rejections by default. Override with options.cachePromiseRejection = true.
 *
 * ```js
 * const cachedAsyncFn = CacheAsyncFn(asyncFn, options)
 * await cachedAsyncFn(key)
 * await cachedAsyncFn(key)
 * cachedAsyncFn.clear()
 * ```
 */
export function CacheAsyncFn<ArgsType extends any[], ReturnType, KeyType = ArgsType[0]>(asyncFn: (...args: ArgsType) => PromiseLike<ReturnType>, {
    maxSize = 10000,
    maxAge = 30 * 60 * 1000, // 30 minutes
    cachePromiseRejection = false,
    onEviction = () => {},
    cacheKey = (args: ArgsType) => args[0], // type+provide default so we can infer KeyType
    ...opts
}: {
    maxSize?: number
    maxAge?: number
    cachePromiseRejection?: boolean
    onEviction?: (...args: any[]) => void
    cacheKey?: (args: ArgsType) => KeyType
} = {}): ((...args: ArgsType) => Promise<ReturnType>) & { clearMatching: (matchFn: (key: KeyType) => boolean) => void } {
    const cache = new LRU<KeyType, { data: ReturnType, maxAge: number }>({
        maxSize,
        maxAge,
        onEviction,
    })

    const cachedFn = Object.assign(pMemoize(asyncFn, {
        cachePromiseRejection,
        cache,
        cacheKey,
        ...opts,
    }), {
        clearMatching: (matchFn: ((key: KeyType) => boolean)) => clearMatching(cache, matchFn),
    })

    return cachedFn
}

/**
 * Returns a cached fn, cached keyed on first argument passed. See documentation for mem.
 * Caches into a LRU cache capped at options.maxSize
 * Won't call fn again until options.maxAge or options.maxSize exceeded, or cachedFn.clear() is called.
 *
 * ```js
 * const cachedFn = CacheFn(fn, options)
 * cachedFn(key)
 * cachedFn(key)
 * cachedFn(...args)
 * cachedFn.clear()
 * ```
 */

export function CacheFn<ArgsType extends any[], ReturnType, KeyType = ArgsType[0]>(fn: (...args: ArgsType) => ReturnType, {
    maxSize = 10000,
    maxAge = 30 * 60 * 1000, // 30 minutes
    onEviction = () => {},
    cacheKey = (args: ArgsType) => args[0], // type+provide default so we can infer KeyType
    ...opts
}: {
    maxSize?: number
    maxAge?: number
    onEviction?: (...args: any[]) => void
    cacheKey?: (args: ArgsType) => KeyType
} = {}): ((...args: ArgsType) => ReturnType) & { clearMatching: (matchFn: (key: KeyType) => boolean) => void } {
    const cache = new LRU<KeyType, { data: ReturnType, maxAge: number }>({
        maxSize,
        maxAge,
        onEviction,
    })

    const cachedFn = Object.assign(mem(fn, {
        cache,
        cacheKey,
        ...opts,
    }), {
        clearMatching: (matchFn: ((key: KeyType) => boolean)) => clearMatching(cache, matchFn),
    })

    return cachedFn
}
