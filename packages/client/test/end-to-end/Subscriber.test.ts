import { StreamMessage, StreamPartID } from 'streamr-client-protocol'
import { fastPrivateKey, wait } from 'streamr-test-utils'
import {
    toStreamDefinition,
    createPartitionedTestStream,
    createStreamPartIterator
} from '../test-utils/utils'
import { getPublishTestMessages } from '../test-utils/publish'
import { StreamrClient } from '../../src/StreamrClient'
import { Defer } from '../../src/utils/Defer'
import { Subscription } from '../../src/subscribe/Subscription'
import { Subscriber } from '../../src/subscribe/Subscriber'
import { ConfigTest, MaybeAsync, StreamDefinition } from '../../src'

const MAX_ITEMS = 3
const NUM_MESSAGES = 8
jest.setTimeout(60000)

const collect = async <T>(
    iterator: AsyncGenerator<StreamMessage<T>>,
    fn: MaybeAsync<(item: {
        msg: StreamMessage<T>,
        iterator: AsyncGenerator<StreamMessage<T>>,
        received: T[]
    }) => void> = async () => {}
): Promise<T[]> => {
    const received: T[] = []
    for await (const msg of iterator) {
        received.push(msg.getParsedContent())
        await fn({
            msg, iterator, received,
        })
    }
    return received
}

describe.skip('Subscriber', () => { // TODO enable the test when it doesn't depend on PublishPipeline (via getPublishTestMessages)
    let expectErrors = 0 // check no errors by default
    let onError = jest.fn()
    let client: StreamrClient
    let privateKey: string
    let streamParts: AsyncGenerator<StreamPartID>
    let streamDefinition: StreamDefinition
    let M: Subscriber
    let publishTestMessages: ReturnType<typeof getPublishTestMessages>

    beforeAll(async () => {
        const stream = await createPartitionedTestStream(module)
        streamParts = createStreamPartIterator(stream)
    })

    beforeEach(async () => {
        streamDefinition = toStreamDefinition((await (await streamParts.next()).value))
        expectErrors = 0
        onError = jest.fn()
    })

    beforeEach(async () => {
        privateKey = fastPrivateKey()
        client = new StreamrClient({
            ...ConfigTest,
            auth: {
                privateKey
            }
        })
        // @ts-expect-error private
        M = client.subscriber
        client.debug('connecting before test >>')
        await Promise.all([
            client.connect(),
        ])
        client.debug('connecting before test <<')
        publishTestMessages = getPublishTestMessages(client, streamDefinition)
    })

    afterEach(async () => {
        client.debug('after test')
        expect(await M.count()).toBe(0)
        expect(await M.count(streamDefinition)).toBe(0)
        expect(M.countSubscriptionSessions()).toBe(0)
    })

    afterEach(async () => {
        await wait(0)
        // ensure no unexpected errors
        expect(onError).toHaveBeenCalledTimes(expectErrors)
    })

    describe('basics', () => {
        it('works when passing stream', async () => {
            const sub = await M.subscribe(streamDefinition)
            expect(await M.count(streamDefinition)).toBe(1)

            const published = await publishTestMessages(NUM_MESSAGES)

            const received = await sub.collectContent(published.length)
            expect(received).toEqual(published)
            expect(received).toHaveLength(NUM_MESSAGES)
        })

        it('works when passing { stream: stream }', async () => {
            const sub = await M.subscribe(streamDefinition)
            expect(await M.count(streamDefinition)).toBe(1)

            const published = await publishTestMessages()

            const received = await sub.collectContent(published.length)
            expect(received).toEqual(published)
        })

        it('works when passing streamId as string', async () => {
            const sub = await M.subscribe(streamDefinition)
            expect(await M.count(streamDefinition)).toBe(1)

            const published = await publishTestMessages()

            const received = await sub.collectContent(published.length)
            expect(received).toEqual(published)
            expect(await M.count(streamDefinition)).toBe(0)
        })

        // it('errors if not connected', async () => {
        // await client.destroy()
        // await expect(() => (
        // M.subscribe(streamDefinition)
        // )).rejects.toThrow('connect')
        // expect(await M.count(streamDefinition)).toBe(0)
        // })

        it('errors if iterating twice', async () => {
            const sub = await M.subscribe(streamDefinition)
            const c1 = sub.collect()

            await expect(async () => (
                sub.collect()
            )).rejects.toThrow()
            await sub.unsubscribe()
            const m = await c1

            expect(m).toEqual([])

            expect(await M.count(streamDefinition)).toBe(0)
        })

        describe('subscription error handling', () => {
            it('works when error thrown inline', async () => {
                const err = new Error('expected')
                const sub = (await M.subscribe(streamDefinition)).pipe(async function* ThrowError(s) {
                    let count = 0
                    for await (const msg of s) {
                        if (count === MAX_ITEMS) {
                            throw err
                        }
                        count += 1
                        yield msg
                    }
                })

                expect(await M.count(streamDefinition)).toBe(1)

                const published = await publishTestMessages(NUM_MESSAGES, {
                    timestamp: 111111,
                })

                const onErrorHandler = jest.fn()
                sub.onError.listen(onErrorHandler)

                const received: unknown[] = []
                for await (const msg of sub) {
                    received.push(msg.getParsedContent())
                }
                expect(onErrorHandler).toHaveBeenCalledWith(err)
                expect(received).toEqual(published.slice(0, MAX_ITEMS))
                await wait(100)
            })

            it('works when multiple steps error', async () => {
                const err = new Error('expected')

                const sub = await M.subscribe(streamDefinition)

                const v = sub
                    .pipe(async function* ThrowError1(s) {
                        let count = 0
                        for await (const msg of s) {
                            if (count === MAX_ITEMS) {
                                throw err
                            }
                            count += 1
                            yield msg
                        }
                    })
                    .pipe(async function* ThrowError2(s) {
                        let count = 0
                        for await (const msg of s) {
                            if (count === MAX_ITEMS) {
                                throw err
                            }
                            count += 1
                            yield msg
                        }
                    })

                expect(await M.count(streamDefinition)).toBe(1)

                const published = await publishTestMessages(NUM_MESSAGES, {
                    timestamp: 111111,
                })

                const onErrorHandler = jest.fn()
                sub.onError.listen(onErrorHandler)

                const received: any[] = []
                for await (const m of v) {
                    received.push(m.getParsedContent())
                }
                expect(onErrorHandler).toHaveBeenCalledWith(err)
                expect(received).toEqual(published.slice(0, MAX_ITEMS))
            })

            it('keeps other subscriptions running if one subscription errors', async () => {
                const err = new Error('expected')
                const sub1 = await M.subscribe(streamDefinition)
                const sub2 = await M.subscribe(streamDefinition)

                let count = 0
                sub1.pipe(async function* ThrowError(s) {
                    for await (const msg of s) {
                        if (count === MAX_ITEMS) {
                            sub1.debug('throwing...')
                            throw err
                        }
                        count += 1
                        yield msg
                    }
                })

                const published = await publishTestMessages(NUM_MESSAGES, {
                    timestamp: 111111,
                })

                const onErrorHandler = jest.fn()
                sub1.onError.listen(onErrorHandler)

                await sub1.collectContent(NUM_MESSAGES)
                const received = await sub2.collectContent(NUM_MESSAGES)
                expect(onErrorHandler).toHaveBeenCalledWith(err)
                expect(received).toEqual(published)
                expect(count).toEqual(MAX_ITEMS)
            })

            it('errors subscription iterator do not trigger onError', async () => {
                const err = new Error('expected')
                const sub1 = await M.subscribe(streamDefinition)

                const onError1 = jest.fn()
                sub1.onError.listen(onError1)

                let count = 0
                const published = await publishTestMessages(NUM_MESSAGES, {
                    timestamp: 111111,
                })
                const received1: any[] = []
                await expect(async () => {
                    for await (const msg of sub1) {
                        if (count === MAX_ITEMS) {
                            sub1.debug('throwing...')
                            throw err
                        }
                        count += 1
                        received1.push(msg.getParsedContent())
                    }
                }).rejects.toThrow(err)

                expect(received1).toEqual(published.slice(0, MAX_ITEMS))
                expect(onError1).toHaveBeenCalledTimes(0)
            })

            it('errors subscription onMessage callback do trigger onError', async () => {
                const err = new Error('expected')
                let count = 0
                const received1: any[] = []
                const sub1 = await M.subscribe(streamDefinition, (content) => {
                    if (count === MAX_ITEMS) {
                        sub1.debug('throwing...')
                        throw err
                    }
                    count += 1
                    received1.push(content)
                })

                const onError1 = jest.fn()
                sub1.onError.listen(onError1)

                const published = await publishTestMessages(NUM_MESSAGES, {
                    timestamp: 111111,
                })

                expect(received1).toEqual(published.slice(0, MAX_ITEMS))
                expect(onError1).toHaveBeenCalledTimes(1)
            })

            it('errors in onMessage callback are not handled by other subscriptions', async () => {
                const err = new Error('expected')
                let count = 0
                const received1: any[] = []
                const sub1 = await M.subscribe(streamDefinition, (content) => {
                    if (count === MAX_ITEMS) {
                        sub1.debug('throwing...')
                        throw err
                    }
                    count += 1
                    received1.push(content)
                })

                const sub2 = await M.subscribe(streamDefinition)

                const onError1 = jest.fn()
                sub1.onError.listen(onError1)
                const onError2 = jest.fn()
                sub2.onError.listen(onError2)

                const published = await publishTestMessages(NUM_MESSAGES, {
                    timestamp: 111111,
                })

                const received = await sub2.collectContent(NUM_MESSAGES)
                expect(received).toEqual(published)
                expect(onError1).toHaveBeenCalledTimes(1)
                expect(onError1).toHaveBeenCalledWith(err)
                expect(onError2).toHaveBeenCalledTimes(0)
                expect(count).toEqual(MAX_ITEMS)
                expect(await M.count(streamDefinition)).toBe(0)
            })

            /*
            describe('error is bad groupkey', () => {
                let sub: Subscription
                const BAD_GROUP_KEY_ID = 'BAD_GROUP_KEY_ID'

                beforeEach(async () => {
                    await client.publisher.startKeyExchange()
                    sub = await M.subscribe({
                        ...stream,
                        // @ts-expect-error not in type but works
                        beforeSteps: [
                            async function* ThrowError(s: AsyncIterable<any>) {
                                let count = 0
                                for await (const msg of s) {
                                    if (count === MAX_ITEMS) {
                                        msg.streamMessage.encryptionType = 2
                                        msg.streamMessage.groupKeyId = BAD_GROUP_KEY_ID
                                    }
                                    count += 1
                                    yield msg
                                }
                            }
                        ]
                    })

                    expect(await M.count(streamDefinition)).toBe(1)
                })

                it('throws subscription loop when encountering bad message', async () => {
                    const published = await publishTestMessages(NUM_MESSAGES, {
                        timestamp: 111111,
                    })

                    const received: unknown[] = []
                    await expect(async () => {
                        for await (const m of sub) {
                            received.push(m.getParsedContent())
                        }
                    }).rejects.toThrow(BAD_GROUP_KEY_ID)
                    expect(received).toEqual(published.slice(0, MAX_ITEMS))
                })

            })
            */

            it('will skip bad message if error handler attached', async () => {
                const err = new Error('expected')

                const sub = await M.subscribe(streamDefinition)
                sub.forEach((_item, index) => {
                    if (index === MAX_ITEMS) {
                        sub.debug('THROWING ERR')
                        throw err
                    }
                })

                const onSubscriptionError = jest.fn((error: Error) => {
                    sub.debug('onSubscriptionError', error)
                })
                sub.onError.listen(onSubscriptionError)

                const published = await publishTestMessages(NUM_MESSAGES, {
                    timestamp: 111111,
                })

                const received = []
                let t!: ReturnType<typeof setTimeout>
                for await (const m of sub) {
                    received.push(m.getParsedContent())
                    if (received.length === published.length - 1) {
                        // eslint-disable-next-line no-loop-func
                        t = setTimeout(() => {
                            // give it a moment to incorrectly get messages
                            sub.unsubscribe()
                        }, 100)
                    }

                    if (received.length === published.length) {
                        break
                    }
                }
                clearTimeout(t)
                expect(received).toEqual([
                    ...published.slice(0, MAX_ITEMS),
                    ...published.slice(MAX_ITEMS + 1)
                ])
                expect(onSubscriptionError).toHaveBeenCalledTimes(1)
            })

            it('will not skip bad message if error handler attached & throws', async () => {
                const err = new Error('expected')

                const sub = await M.subscribe(streamDefinition)

                sub.forEach((_item, index) => {
                    if (index === MAX_ITEMS) {
                        throw err
                    }
                })

                const received: any[] = []
                const onSubscriptionError = jest.fn((error: Error) => {
                    throw error
                })

                sub.onError.listen(onSubscriptionError)

                const published = await publishTestMessages(NUM_MESSAGES, {
                    timestamp: 111111,
                })

                await expect(async () => {
                    for await (const m of sub) {
                        received.push(m.getParsedContent())
                        if (received.length === published.length) {
                            break
                        }
                    }
                }).rejects.toThrow()
                expect(received).toEqual(published.slice(0, MAX_ITEMS))
                expect(onSubscriptionError).toHaveBeenCalledTimes(1)
            })
        })
    })

    describe('ending a subscription', () => {
        it('can kill stream using async unsubscribe', async () => {
            const sub = await M.subscribe(streamDefinition)
            expect(await M.count(streamDefinition)).toBe(1)

            await publishTestMessages()
            let unsubscribeTask!: Promise<any>
            let t!: ReturnType<typeof setTimeout>
            let expectedLength = -1
            const received = []
            try {
                for await (const m of sub) {
                    received.push(m.getParsedContent())
                    // after first message schedule end
                    if (received.length === 1) {
                        // eslint-disable-next-line no-loop-func
                        t = setTimeout(() => {
                            expectedLength = received.length
                            // should not see any more messages after end
                            unsubscribeTask = sub.unsubscribe()
                        })
                    }
                }

                expect(unsubscribeTask).toBeTruthy()
                // gets some messages but not all
                expect(received).toHaveLength(expectedLength)
            } finally {
                clearTimeout(t)
                await unsubscribeTask
            }
        })

        it('can kill stream with throw', async () => {
            const sub = await M.subscribe(streamDefinition)
            expect(await M.count(streamDefinition)).toBe(1)

            await publishTestMessages()

            const err = new Error('expected error')
            const received: unknown[] = []
            await expect(async () => {
                for await (const m of sub) {
                    received.push(m.getParsedContent())
                    // after first message schedule end
                    if (received.length === 1) {
                        throw err
                    }
                }
            }).rejects.toThrow(err)
            // gets some messages but not all
            expect(received).toHaveLength(1)
        })

        it('can subscribe to stream multiple times, get updates then unsubscribe', async () => {
            const sub1 = await M.subscribe(streamDefinition)
            const sub2 = await M.subscribe(streamDefinition)

            expect(await M.count(streamDefinition)).toBe(2)

            const published = await publishTestMessages()

            const [received1, received2] = await Promise.all([
                collect(sub1, async ({ received, iterator }) => {
                    if (received.length === published.length) {
                        await iterator.return(undefined)
                    }
                }),
                collect(sub2, async ({ received, iterator }) => {
                    if (received.length === published.length) {
                        await iterator.return(undefined)
                    }
                })
            ])

            expect(received1).toEqual(published)
            expect(received2).toEqual(received1)
        })

        it('can subscribe to stream multiple times in parallel, get updates then unsubscribe', async () => {
            const [sub1, sub2] = await Promise.all([
                M.subscribe(streamDefinition),
                M.subscribe(streamDefinition),
            ])

            expect(await M.count(streamDefinition)).toBe(2)
            const published = await publishTestMessages()

            const [received1, received2] = await Promise.all([
                collect(sub1, async ({ received, iterator }) => {
                    if (received.length === published.length) {
                        await iterator.return(undefined)
                    }
                }),
                collect(sub2, async ({ received, iterator }) => {
                    if (received.length === published.length) {
                        await iterator.return(undefined)
                    }
                })
            ])

            expect(received1).toEqual(published)
            expect(received2).toEqual(received1)
        })

        it('can subscribe to stream and get some updates then unsubscribe mid-stream with end', async () => {
            const sub = await M.subscribe(streamDefinition)
            expect(await M.count(streamDefinition)).toBe(1)

            const published = await publishTestMessages()

            const received = []
            for await (const m of sub) {
                received.push(m.getParsedContent())
                if (received.length === 1) {
                    await sub.unsubscribe()
                }
            }

            expect(received).toEqual(published.slice(0, 1))
            expect(await M.count(streamDefinition)).toBe(0)
        })

        it('finishes unsubscribe before returning', async () => {
            const sub = await M.subscribe(streamDefinition)

            const published = await publishTestMessages()

            const received = []
            for await (const m of sub) {
                received.push(m.getParsedContent())
                if (received.length === MAX_ITEMS) {
                    await sub.return()
                    expect(await M.count(streamDefinition)).toBe(0)
                }
            }
            expect(received).toHaveLength(MAX_ITEMS)
            expect(received).toEqual(published.slice(0, MAX_ITEMS))
        })

        it('finishes unsubscribe before returning from cancel', async () => {
            const sub = await M.subscribe(streamDefinition)

            const published = await publishTestMessages()

            const received = []
            for await (const m of sub) {
                received.push(m.getParsedContent())
                if (received.length === MAX_ITEMS) {
                    await sub.unsubscribe()
                    expect(await M.count(streamDefinition)).toBe(0)
                }
            }
            expect(received).toHaveLength(MAX_ITEMS)
            expect(received).toEqual(published.slice(0, MAX_ITEMS))
        })

        it('can unsubscribe + return and it will wait for unsubscribe', async () => {
            const sub = await M.subscribe(streamDefinition)

            const published = await publishTestMessages()

            const received = []
            for await (const m of sub) {
                received.push(m.getParsedContent())
                if (received.length === MAX_ITEMS) {
                    await Promise.all([
                        sub.return(),
                        sub.unsubscribe(),
                    ])
                    expect(await M.count(streamDefinition)).toBe(0)
                }
            }
            expect(received).toHaveLength(MAX_ITEMS)
            expect(received).toEqual(published.slice(0, MAX_ITEMS))
        })

        it('can cancel multiple times and it will wait for unsubscribe', async () => {
            const sub = await M.subscribe(streamDefinition)

            const published = await publishTestMessages()

            const received = []
            for await (const m of sub) {
                received.push(m.getParsedContent())
                if (received.length === MAX_ITEMS) {
                    const tasks = [
                        sub.unsubscribe(),
                        sub.unsubscribe(),
                        sub.unsubscribe(),
                    ]
                    await Promise.all(tasks)
                    expect(await M.count(streamDefinition)).toBe(0)
                }
            }
            expect(received).toHaveLength(MAX_ITEMS)
            expect(received).toEqual(published.slice(0, MAX_ITEMS))
        })

        it('will clean up if iterator returned before start', async () => {
            const sub = await M.subscribe(streamDefinition)
            expect(await M.count(streamDefinition)).toBe(1)
            await sub.return()
            expect(await M.count(streamDefinition)).toBe(0)

            await publishTestMessages()

            const received = []
            for await (const m of sub) {
                received.push(m.getParsedContent())
            }
            expect(received).toHaveLength(0)

            expect(await M.count(streamDefinition)).toBe(0)
        })

        it('can subscribe then unsubscribe in parallel', async () => {
            const [sub] = await Promise.all([
                M.subscribe(streamDefinition),
                M.unsubscribe(streamDefinition),
            ])

            expect(await M.count(streamDefinition)).toBe(1)

            const published = await publishTestMessages(3)

            const received = await sub.collectContent(3)

            expect(received).toEqual(published)
            expect(await M.count(streamDefinition)).toBe(0)
        })

        it('can unsubscribe then subscribe in parallel', async () => {
            const [_, sub] = await Promise.all([
                M.unsubscribe(streamDefinition),
                M.subscribe(streamDefinition),
            ])

            expect(await M.count(streamDefinition)).toBe(1)

            const published = await publishTestMessages(3)

            const received = await sub.collectContent(3)

            expect(received).toEqual(published)
            expect(await M.count(streamDefinition)).toBe(0)
        })
    })

    describe('mid-stream stop methods', () => {
        let sub1: Subscription<unknown>
        let sub2: Subscription<unknown>
        let published: unknown[]

        beforeEach(async () => {
            sub1 = await M.subscribe(streamDefinition)
            sub2 = await M.subscribe(streamDefinition)
            published = await publishTestMessages(5, { delay: 50 })
        })

        it('can subscribe to stream multiple times then unsubscribe all mid-stream', async () => {
            let sub1Received: unknown[] = []
            let sub1ReceivedAtUnsubscribe: unknown[] = []
            const gotOne = Defer()
            let didGetOne = false
            const [received1, received2] = await Promise.all([
                collect(sub1, async ({ received }) => {
                    sub1Received = received
                    didGetOne = true
                    gotOne.resolve(undefined)
                }),
                collect(sub2, async ({ received }) => {
                    if (!didGetOne) { // don't delay unsubscribe
                        await gotOne
                    }

                    if (received.length === MAX_ITEMS) {
                        await M.unsubscribe(streamDefinition)
                        sub1ReceivedAtUnsubscribe = sub1Received.slice()
                    }
                }),
            ])
            expect(received1).toEqual(published.slice(0, sub1ReceivedAtUnsubscribe.length))
            expect(received2).toEqual(published.slice(0, MAX_ITEMS))
            expect(sub1ReceivedAtUnsubscribe).toEqual(sub1Received)
            expect(await M.count(streamDefinition)).toBe(0)
        })

        it('can subscribe to stream multiple times then unsubscribe one mid-stream', async () => {
            let sub2ReceivedAtUnsubscribe
            const [received1, received2] = await Promise.all([
                collect(sub1, async ({ received, iterator }) => {
                    if (received.length === published.length) {
                        await iterator.return(undefined)
                    }
                }),
                collect(sub2, async ({ received }) => {
                    if (received.length === MAX_ITEMS) {
                        sub2ReceivedAtUnsubscribe = received.slice()
                        await sub2.unsubscribe()
                    }
                }),
            ])
            expect(received2).toEqual(published.slice(0, MAX_ITEMS))
            expect(received1).toEqual(published)
            expect(sub2ReceivedAtUnsubscribe).toEqual(received2)
            expect(await M.count(streamDefinition)).toBe(0)
        })

        it('can subscribe to stream multiple times then return mid-stream', async () => {
            const [received1, received2] = await Promise.all([
                collect(sub1, async ({ received, iterator }) => {
                    if (received.length === MAX_ITEMS - 1) {
                        await iterator.return(undefined)
                    }
                }),
                collect(sub2, async ({ received, iterator }) => {
                    if (received.length === MAX_ITEMS) {
                        await iterator.return(undefined)
                    }
                }),
            ])

            expect(received1).toEqual(published.slice(0, MAX_ITEMS - 1))
            expect(received2).toEqual(published.slice(0, MAX_ITEMS))
            expect(await M.count(streamDefinition)).toBe(0)
        })
    })
})
