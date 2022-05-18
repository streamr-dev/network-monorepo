/* eslint-disable */
import { wait } from 'streamr-test-utils'
import { PushBuffer, pull } from '../../src/utils/PushBuffer'
import { counterId } from '../../src/utils'
import { LeaksDetector } from '../test-utils/utils'

import { expected, IteratorTest } from './IteratorTest'

const WAIT = 20

async function* generate(items = expected, waitTime = WAIT) {
    await wait(waitTime * 0.1)
    for await (const item of items) {
        await wait(waitTime * 0.1)
        yield item
        await wait(waitTime * 0.1)
    }
    await wait(waitTime * 0.1)
}

describe('PushBuffer', () => {
    let leaksDetector: LeaksDetector

    beforeEach(async () => {
        leaksDetector = new LeaksDetector()
    })

    afterEach(async () => {
        await leaksDetector.checkNoLeaks()
    })

    IteratorTest('PushBuffer', () => {
        const pushBuffer = new PushBuffer()
        leaksDetector.add('PushBuffer', pushBuffer)
        const gen = generate()
        leaksDetector.add('generator', gen)
        pull(gen, pushBuffer)
        return pushBuffer
    })

    describe('basics', () => {
        it('blocks push when buffer full', async () => {
            const pushBuffer = new PushBuffer(3)
            leaksDetector.add('PushBuffer', pushBuffer)
            expect(await pushBuffer.push(expected[0])).toBe(true)
            expect(await pushBuffer.push(expected[1])).toBe(true)
            const pushResolved1 = jest.fn((v) => v)

            const task1 = pushBuffer.push(expected[2]).then(pushResolved1)
            expect(pushResolved1).toHaveBeenCalledTimes(0)
            await wait(10)
            expect(pushResolved1).toHaveBeenCalledTimes(0)
            expect(await pushBuffer.next()).toEqual({ value: expected[0], done: false })
            // need to wait for next turn of event loop
            await wait(0)
            expect(pushResolved1).toHaveBeenCalledTimes(1)
            expect(await pushBuffer.next()).toEqual({ value: expected[1], done: false })
            expect(await pushBuffer.next()).toEqual({ value: expected[2], done: false })
            expect(await task1).toBe(true)
            pushBuffer.end()
        })

        it('push resolves false if ended', async () => {
            const pushBuffer = new PushBuffer(3)
            leaksDetector.add('PushBuffer', pushBuffer)
            expect(await pushBuffer.push(expected[0])).toBe(true)
            pushBuffer.end()
            expect(await pushBuffer.push(expected[1])).toBe(false)
        })

        it('push resolves false if errored', async () => {
            const err = new Error(counterId('expected error'))
            const pushBuffer = new PushBuffer(3)
            leaksDetector.add('PushBuffer', pushBuffer)
            leaksDetector.add('error', err)
            expect(await pushBuffer.push(expected[0])).toBe(true)
            expect(await pushBuffer.push(expected[1])).toBe(true)
            const pushTask = pushBuffer.push(expected[2]) // this should block then resolve false on pushBuffer throw
            // 4 items buffered, last push call pending
            // first next call should succeed
            const nextTask1 = pushBuffer.next()
            // second next call should succeed
            const nextTask2 = pushBuffer.next()
            // from here on all next calls should error
            const throwTask = pushBuffer.throw(err)
            // this next call is after throw, so should fail
            const nextTask3 = pushBuffer.next()
            await Promise.allSettled([pushTask, throwTask, nextTask1, nextTask2, nextTask3])
            await expect(throwTask).rejects.toThrow(err)
            expect(await pushTask).toBe(false)
            expect(await nextTask1).toEqual({ value: expected[0], done: false })
            expect(await nextTask2).toEqual({ value: expected[1], done: false })
            expect(await nextTask3).toEqual({ value: undefined, done: true })
        })

        it('push resolves false if errored with delayed push', async () => {
            const err = new Error(counterId('expected error'))
            const pushBuffer = new PushBuffer(2)
            leaksDetector.add('PushBuffer', pushBuffer)
            leaksDetector.add('error', err)
            expect(await pushBuffer.push(expected[0])).toBe(true)
            // 4 items buffered, last push call pending
            // first next call should succeed
            const nextTask1 = pushBuffer.next()
            // second next call should succeed
            const nextTask2 = pushBuffer.next()
            expect(await pushBuffer.push(expected[1])).toBe(true)
            const pushTask1 = pushBuffer.push(expected[1]) // this should resolve true due to outstanding next
            const pushTask2 = pushBuffer.push(expected[2]) // this should block then resolve false, throw called before next
            // from here on all next calls should error
            const throwTask = pushBuffer.throw(err)
            // this next call is after throw, so should fail
            const nextTask3 = pushBuffer.next()
            await Promise.allSettled([pushTask1, pushTask2, throwTask, nextTask1, nextTask2, nextTask3])
            await expect(throwTask).rejects.toThrow(err)
            expect(await pushTask1).toBe(true)
            expect(await pushTask2).toBe(false)
            expect(await nextTask1).toEqual({ value: expected[0], done: false })
            expect(await nextTask2).toEqual({ value: expected[1], done: false })
            expect(await nextTask3).toEqual({ value: undefined, done: true })
        })

        it('can queue multiple pushes', async () => {
            const pushBuffer = new PushBuffer(3)
            expect(await pushBuffer.push(expected[0])).toBe(true)
            expect(await pushBuffer.push(expected[1])).toBe(true)
            const pushResolved1 = jest.fn((v) => v)
            const pushResolved2 = jest.fn((v) => v)
            const pushResolved3 = jest.fn((v) => v)
            // this shouldn't happen, should wait for previous push to resolve before pushing again
            const task1 = pushBuffer.push(expected[2]).then(pushResolved1)
            const task2 = pushBuffer.push(expected[3]).then(pushResolved2)
            const task3 = pushBuffer.push(expected[4]).then(pushResolved3)
            expect(pushResolved1).toHaveBeenCalledTimes(0)
            expect(pushResolved2).toHaveBeenCalledTimes(0)
            expect(pushResolved3).toHaveBeenCalledTimes(0)
            await wait(10)
            expect(pushResolved1).toHaveBeenCalledTimes(0)
            expect(pushResolved2).toHaveBeenCalledTimes(0)
            expect(pushResolved3).toHaveBeenCalledTimes(0)
            expect(await pushBuffer.next()).toEqual({ value: expected[0], done: false })
            await wait(0)
            expect(pushResolved1).toHaveBeenCalledTimes(0)
            expect(pushResolved2).toHaveBeenCalledTimes(0)
            expect(pushResolved3).toHaveBeenCalledTimes(0)
            expect(await pushBuffer.next()).toEqual({ value: expected[1], done: false })
            await wait(0)
            expect(pushResolved1).toHaveBeenCalledTimes(0)
            expect(pushResolved2).toHaveBeenCalledTimes(0)
            expect(pushResolved3).toHaveBeenCalledTimes(0)
            expect(await pushBuffer.next()).toEqual({ value: expected[2], done: false })
            await wait(0)
            // all unblock at once, push resolves when buffer has space
            expect(pushResolved1).toHaveBeenCalledTimes(1)
            expect(pushResolved2).toHaveBeenCalledTimes(1)
            expect(pushResolved3).toHaveBeenCalledTimes(1)
            expect(await pushBuffer.next()).toEqual({ value: expected[3], done: false })
            await wait(0)
            expect(pushResolved1).toHaveBeenCalledTimes(1)
            expect(pushResolved2).toHaveBeenCalledTimes(1)
            expect(pushResolved3).toHaveBeenCalledTimes(1)
            expect(await pushBuffer.next()).toEqual({ value: expected[4], done: false })
            await wait(0)
            expect(pushResolved2).toHaveBeenCalledTimes(1)
            expect(pushResolved1).toHaveBeenCalledTimes(1)
            expect(pushResolved3).toHaveBeenCalledTimes(1)
            await wait(0)
            expect(await task1).toBe(true)
            expect(await task2).toBe(true)
            expect(await task3).toBe(true)
        })

        it('errors on bad buffer size', async () => {
            expect(() => {
                new PushBuffer(0) // eslint-disable-line no-new
            }).toThrow('bufferSize')
            expect(() => {
                new PushBuffer(-1) // eslint-disable-line no-new
            }).toThrow('bufferSize')
            expect(() => {
                new PushBuffer(Number.MAX_SAFE_INTEGER + 10) // eslint-disable-line no-new
            }).toThrow('bufferSize')
            expect(() => {
                new PushBuffer(1.5) // eslint-disable-line no-new
            }).toThrow('bufferSize')
            expect(() => {
                new PushBuffer(0.5) // eslint-disable-line no-new
            }).toThrow('bufferSize')
        })

        it('can push inside pull', async () => {
            const items = expected.slice()
            const pushBuffer = new PushBuffer<number>()
            await pushBuffer.push(items.shift()!)
            const received: number[] = []
            for await (const msg of pushBuffer) {
                received.push(msg)
                const nextItem = items.shift()!
                if (nextItem != null) {
                    await pushBuffer.push(nextItem)
                } else {
                    break
                }
            }

            expect(received).toEqual(expected)
        })

        it('can not read after end', async () => {
            const pushBuffer = new PushBuffer<number>()
            await pushBuffer.push(expected[0])
            await pushBuffer.push(expected[1])
            await pushBuffer.push(expected[2])
            pushBuffer.end()
            const received: number[] = []
            for await (const msg of pushBuffer) {
                received.push(msg)
            }

            expect(received).toEqual([])
        })

        it('will not read buffered items after end if iterating', async () => {
            const pushBuffer = new PushBuffer<number>()
            await pushBuffer.push(expected[0])
            await pushBuffer.push(expected[1])
            const received: number[] = []
            for await (const msg of pushBuffer) {
                received.push(msg)
                if (received.length === 1) {
                    pushBuffer.push(expected[2]) // don't await
                    pushBuffer.end()
                }
            }

            expect(received).toEqual(expected.slice(0, 1))
        })

        it('ignores push after end', async () => {
            const pushBuffer = new PushBuffer<number>()
            await pushBuffer.push(expected[0])
            await pushBuffer.push(expected[1]) // will be dropped
            const received: number[] = []
            for await (const msg of pushBuffer) {
                received.push(msg)
                if (received.length === 1) {
                    pushBuffer.end()
                    pushBuffer.push(expected[2])
                }
            }

            expect(received).toEqual(expected.slice(0, 1))
        })

        it('can defer error with endWrite', async () => {
            const err = new Error(counterId('expected'))
            const pushBuffer = new PushBuffer<number>()
            await pushBuffer.push(expected[0])
            await pushBuffer.push(expected[1])
            await pushBuffer.push(expected[2])
            pushBuffer.endWrite(err)
            const ok = await pushBuffer.push(expected[3])
            expect(ok).toEqual(false)
            const received: number[] = []
            await expect(async () => {
                for await (const msg of pushBuffer) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected.slice(0, 3))
        })

        it('can read after endWrite', async () => {
            const pushBuffer = new PushBuffer<number>()
            await pushBuffer.push(expected[0])
            await pushBuffer.push(expected[1])
            await pushBuffer.push(expected[2])
            pushBuffer.endWrite()
            const received: number[] = []
            for await (const msg of pushBuffer) {
                received.push(msg)
            }

            expect(received).toEqual(expected.slice(0, 3))
        })

        it('can defer error with endWrite', async () => {
            const err = new Error(counterId('expected'))
            const pushBuffer = new PushBuffer<number>()
            await pushBuffer.push(expected[0])
            await pushBuffer.push(expected[1])
            await pushBuffer.push(expected[2])
            pushBuffer.endWrite(err)
            const ok = await pushBuffer.push(expected[3])
            expect(ok).toEqual(false)
            const received: number[] = []
            await expect(async () => {
                for await (const msg of pushBuffer) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected.slice(0, 3))
        })

        describe('pull', () => {
            it('pulls until buffer full', async () => {
                const pushBuffer = new PushBuffer(3)
                let lastGenerated!: number
                const onFinallyAfter = jest.fn()
                const onFinally = jest.fn(async () => {
                    await wait(0)
                    onFinallyAfter()
                })
                async function* generateWithLast() {
                    try {
                        for await (const v of generate()) {
                            lastGenerated = v
                            yield v
                        }
                    } finally {
                        await onFinally()
                    }
                }

                pull(generateWithLast(), pushBuffer)

                await wait(WAIT * 10) // give time to generate too many
                expect(lastGenerated).toBe(expected[2])
                // pulling one item out of the buffer should pull from source again
                expect(await pushBuffer.next()).toEqual({ value: expected[0], done: false })
                await wait(WAIT * 2) // should only pull next item
                expect(lastGenerated).toBe(expected[3])
                // no mater how long we wait
                await wait(WAIT * 2)
                expect(lastGenerated).toBe(expected[3])
                // return should not pull any more
                await pushBuffer.return()
                expect(lastGenerated).toBe(expected[3])
                await wait(WAIT * 2)
                expect(lastGenerated).toBe(expected[3])
                // make sure generator ended
                expect(onFinally).toHaveBeenCalledTimes(1)
                expect(onFinallyAfter).toHaveBeenCalledTimes(1)
            })

            it('defers errors', async () => {
                const pushBuffer = new PushBuffer<number>()
                const pushBuffer2 = new PushBuffer<number>(1)
                const err = new Error(counterId('expected'))
                async function* generateWithLast() {
                    yield* generate()
                    throw err
                }

                pull(generateWithLast(), pushBuffer)
                pull(pushBuffer, pushBuffer2)
                const received: number[] = []
                await expect(async () => {
                    for await (const msg of pushBuffer2) {
                        received.push(msg)
                        await wait(WAIT * 3)
                    }
                }).rejects.toThrow(err)

                expect(received).toEqual(expected)
            })

            it('can clear buffered items', async () => {
                const pushBuffer = new PushBuffer<number>()
                await pushBuffer.push(expected[0])
                await pushBuffer.push(expected[1])
                await pushBuffer.push(expected[2])
                await pushBuffer.push(expected[3])
                await pushBuffer.push(expected[4])
                const received: number[] = []
                for await (const msg of pushBuffer) {
                    received.push(msg)
                    if (received.length === 3) {
                        pushBuffer.clear()
                        setTimeout(async () => {
                            await pushBuffer.push(expected[5])
                            await pushBuffer.return()
                        })
                    }
                }

                expect(received).toEqual([...expected.slice(0, 3), expected[5]])
            })
        })
    })
})