export const expected = [1, 2, 3, 4, 5, 6, 7, 8]

export const MAX_ITEMS = 3

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const WAIT = 20

export function IteratorTest(name, fn) {
    describe(`${name} IteratorTest`, () => {
        it('runs to completion', async () => {
            const received = []
            const itr = fn({
                items: expected, max: MAX_ITEMS
            })
            for await (const msg of itr) {
                received.push(msg)
            }
            expect(received).toEqual(expected)
        })

        it('can return in finally', async () => {
            const received = []
            const itr = (async function* Outer() {
                const innerItr = fn({
                    items: expected, max: MAX_ITEMS
                })[Symbol.asyncIterator]()
                try {
                    yield* innerItr
                } finally {
                    await innerItr.return() // note itr.return would block
                }
            }())

            for await (const msg of itr) {
                received.push(msg)
                if (received.length === MAX_ITEMS) {
                    break
                }
            }
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })

        it('can return mid-iteration', async () => {
            const received = []
            for await (const msg of fn({
                items: expected, max: MAX_ITEMS
            })) {
                received.push(msg)
                if (received.length === MAX_ITEMS) {
                    break
                }
            }
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })

        it('can throw mid-iteration', async () => {
            const received = []
            const err = new Error('expected err')
            await expect(async () => {
                for await (const msg of fn({
                    items: expected, max: MAX_ITEMS
                })) {
                    received.push(msg)
                    if (received.length === MAX_ITEMS) {
                        throw err
                    }
                }
            }).rejects.toThrow(err)
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })

        it('can throw() mid-iteration', async () => {
            const received = []
            const err = new Error('expected err 2')
            await expect(async () => {
                const it = fn({
                    items: expected,
                    max: MAX_ITEMS,
                    errors: [err],
                })
                for await (const msg of it) {
                    received.push(msg)
                    if (received.length === MAX_ITEMS) {
                        await it.throw(err)
                    }
                }
            }).rejects.toThrow(err)
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })

        it('throws parent mid-iteration', async () => {
            const received = []
            const err = new Error('expected err')
            async function* parentGen() {
                const s = fn({
                    items: expected,
                    max: MAX_ITEMS,
                    errors: [err],
                })
                for await (const msg of s) {
                    yield msg
                    if (received.length === MAX_ITEMS) {
                        throw err
                    }
                }
            }
            await expect(async () => {
                for await (const msg of parentGen()) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })

        it('can throw before iterating', async () => {
            const received = []
            const itr = fn({
                items: expected, max: MAX_ITEMS
            })[Symbol.asyncIterator]()
            const err = new Error('expected err')

            await expect(async () => {
                await itr.throw(err)
            }).rejects.toThrow(err)

            // does not throw
            for await (const msg of itr) {
                received.push(msg)
            }
            expect(received).toEqual([])
        })

        it('can return before iterating', async () => {
            const itr = fn({
                items: expected, max: MAX_ITEMS
            })[Symbol.asyncIterator]()
            await itr.return()
            const received = []
            for await (const msg of itr) {
                received.push(msg)
            }
            expect(received).toEqual([])
        })

        it('can queue next calls', async () => {
            const itr = fn({
                items: expected,
                max: MAX_ITEMS
            })[Symbol.asyncIterator]()
            const tasks = expected.map(async () => itr.next())
            const received = await Promise.all(tasks)
            expect(received.map(({ value }) => value)).toEqual(expected)
            await itr.return()
        })

        it('can queue delayed next calls', async () => {
            const itr = fn({
                items: expected, max: MAX_ITEMS
            })[Symbol.asyncIterator]()
            const tasks = expected.map(async () => {
                await wait(WAIT)
                return itr.next()
            })
            const received = await Promise.all(tasks)
            expect(received.map(({ value }) => value)).toEqual(expected)
            await itr.return()
        })

        it('can queue delayed next calls resolving out of order', async () => {
            const itr = fn({
                items: expected, max: MAX_ITEMS
            })[Symbol.asyncIterator]()
            const tasks = expected.map(async (v, index, arr) => {
                // resolve backwards
                const result = await itr.next()
                await wait(WAIT + (WAIT * 10 * ((arr.length - index) / arr.length)))
                return result
            })
            const received = await Promise.all(tasks)
            expect(received.map(({ value }) => value)).toEqual(expected)
            await itr.return()
        })

        it('can handle error in queued next calls', async () => {
            const itr = fn({
                items: expected,
            })[Symbol.asyncIterator]()
            const err = new Error('expected')
            const tasks = expected.map(async (v, index, arr) => {
                const result = await itr.next()
                await wait(WAIT + WAIT * ((arr.length - index) / arr.length))
                if (index === MAX_ITEMS) {
                    throw err
                }
                return result
            })

            const received = await Promise.allSettled(tasks)

            expect(received).toEqual(expected.map((value, index) => {
                if (index === MAX_ITEMS) {
                    return {
                        status: 'rejected',
                        reason: err
                    }
                }

                return {
                    status: 'fulfilled',
                    value: {
                        done: false,
                        value,
                    }
                }
            }))
            await itr.return()
        })
    })
}
