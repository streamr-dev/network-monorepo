import fs from 'fs'
import path from 'path'
import { fetchPrivateKeyWithGas, wait } from 'streamr-test-utils'
import { StreamMessage } from 'streamr-client-protocol'
import { createTestStream } from '../test-utils/utils'
import { getPublishTestStreamMessages, getWaitForStorage, Msg } from '../test-utils/publish'
import { StreamrClient } from '../../src/StreamrClient'
import { Resends } from '../../src/subscribe/Resends'
import { Stream } from '../../src/Stream'
import { ConfigTest, DOCKER_DEV_STORAGE_NODE } from '../../src/ConfigTest'

/* eslint-disable no-await-in-loop */

const WAIT_FOR_STORAGE_TIMEOUT = process.env.CI ? 20000 : 10000
const MAX_MESSAGES = 5

jest.setTimeout(60000)

describe.skip('resends', () => { // TODO enable the test when it doesn't depend on PublishPipeline (via getPublishTestStreamMessages)
    let expectErrors = 0 // check no errors by default
    let onError = jest.fn()
    let client: StreamrClient
    let stream: Stream
    let publishTestMessages: ReturnType<typeof getPublishTestStreamMessages>
    let waitForStorage: (...args: any[]) => Promise<void>
    let subscriber: Resends

    beforeAll(async () => {
        client = new StreamrClient({
            ...ConfigTest,
            auth: {
                privateKey: await fetchPrivateKeyWithGas()
            }
        })
        // @ts-expect-error private
        subscriber = client.resends

        // eslint-disable-next-line require-atomic-updates
        client.debug('connecting before all tests >>')
        await Promise.all([
            client.connect(),
        ])
        client.debug('connecting before all tests <<')
    })

    beforeAll(async () => {
        client.debug('createStream >>')
        stream = await createTestStream(client, module)
        client.debug('createStream <<')
        client.debug('addToStorageNode >>')
        await stream.addToStorageNode(DOCKER_DEV_STORAGE_NODE)
        client.debug('addToStorageNode <<')

        publishTestMessages = getPublishTestStreamMessages(client, stream.id)

        waitForStorage = getWaitForStorage(client, {
            stream,
            timeout: WAIT_FOR_STORAGE_TIMEOUT,
        })
    }, WAIT_FOR_STORAGE_TIMEOUT * 2)

    beforeEach(async () => {
        await client.connect()
        expectErrors = 0
        onError = jest.fn()
    })

    afterAll(async () => {
        if (client) {
            await client.destroy()
        }
    })

    afterEach(async () => {
        await wait(0)
        // ensure no unexpected errors
        expect(onError).toHaveBeenCalledTimes(expectErrors)
    })

    it('throws error if bad stream id', async () => {
        await expect(async () => {
            await subscriber.resend({
                streamId: 'badstream',
                partition: 0,
            },
            {
                last: 5
            })
        }).rejects.toThrow('badstream')
    })

    it('throws if no storage assigned', async () => {
        const notStoredStream = await createTestStream(client, module)
        await expect(async () => {
            await subscriber.resend({
                streamId: notStoredStream.id,
                partition: 0
            }, {
                last: 5
            })
        }).rejects.toThrow('storage')
    })

    it('throws error if bad partition', async () => {
        await expect(async () => {
            await subscriber.resend({
                streamId: stream.id,
                partition: -1,
            }, {
                last: 5
            })
        }).rejects.toThrow('streamPartition')
    })

    describe('no data', () => {
        it('handles nothing to resend', async () => {
            const sub = await subscriber.resend({
                streamId: stream.id,
                partition: 0,
            }, {
                last: 5,
            })

            const receivedMsgs = await sub.collect()
            expect(receivedMsgs).toHaveLength(0)
        })

        describe('resendSubscribe', () => {
            it('sees realtime when no resend', async () => {
                const stream2 = await createTestStream(client, module)
                await stream2.addToStorageNode(DOCKER_DEV_STORAGE_NODE)

                const publishTestMessagesStream2 = getPublishTestStreamMessages(client, stream2.id)

                const sub = await client.subscribe({
                    streamId: stream2.id,
                    resend: {
                        last: 100
                    }
                })

                const onResent = jest.fn(() => {
                    expect(receivedMsgs).toEqual([])
                })

                sub.once('resendComplete', onResent)
                const publishedStream2 = await publishTestMessagesStream2(3)

                const receivedMsgs: any[] = []
                for await (const msg of sub) {
                    receivedMsgs.push(msg)
                    if (receivedMsgs.length === publishedStream2.length) {
                        break
                    }
                }

                expect(receivedMsgs).toHaveLength(publishedStream2.length)
                expect(receivedMsgs).toEqual(publishedStream2)
                expect(onResent).toHaveBeenCalledTimes(1)
                expect(await client.getSubscriptions(stream2.id)).toHaveLength(0)
            })

            it('can ignore errors in resend', async () => {
                const stream2 = await createTestStream(client, module)
                await stream2.addToStorageNode(DOCKER_DEV_STORAGE_NODE)

                const publishTestMessagesStream2 = getPublishTestStreamMessages(client, stream2.id)

                const sub = await client.subscribe({
                    streamId: stream2.id,
                    resend: {
                        last: 100
                    }
                })

                const receivedMsgs: any[] = []

                const onResent = jest.fn(() => {
                    expect(receivedMsgs).toEqual([])
                })

                // @ts-expect-error internal method
                const mockFn = jest.spyOn(sub, 'getResent') as any
                const err = new Error('expected')
                mockFn.mockRejectedValueOnce(err)
                sub.once('resendComplete', onResent)

                await publishTestMessagesStream2(3)
                await sub.collect(3)

                expect(await client.getSubscriptions(stream2.id)).toHaveLength(0)
                expect(onResent).toHaveBeenCalledTimes(1)
            })

            it('can handle errors in resend', async () => {
                const stream2 = await createTestStream(client, module)
                await stream2.addToStorageNode(DOCKER_DEV_STORAGE_NODE)

                const publishTestMessagesStream2 = getPublishTestStreamMessages(client, stream2.id)

                const sub = await client.subscribe({
                    streamId: stream2.id,
                    resend: {
                        last: 100
                    }
                })

                const onResent = jest.fn(() => {})

                // @ts-expect-error internal method
                const mockFn = jest.spyOn(sub, 'getResent') as any
                const err = new Error('expected')
                mockFn.mockRejectedValueOnce(err)
                sub.once('resendComplete', onResent)
                const onSubError = jest.fn()
                sub.on('error', onSubError) // suppress

                const published = await publishTestMessagesStream2(3)
                const receivedMsgs = await sub.collect(3)

                expect(receivedMsgs).toEqual(published)
                expect(await client.getSubscriptions(stream2.id)).toHaveLength(0)
                expect(onResent).toHaveBeenCalledTimes(1)
                expect(onSubError).toHaveBeenCalledTimes(1)
            })

            it('sees realtime when no storage assigned', async () => {
                const stream2 = await createTestStream(client, module)

                const publishTestMessagesStream2 = getPublishTestStreamMessages(client, stream2.id)

                const sub = await client.subscribe({
                    streamId: stream2.id,
                    resend: {
                        last: 100
                    }
                })

                sub.onError.listen((err: any) => {
                    if (err.code === 'NO_STORAGE_NODES') { return }

                    throw err
                })

                const publishedStream2 = await publishTestMessagesStream2(3)

                const receivedMsgs: any[] = []

                const onResent = jest.fn(() => {
                    expect(receivedMsgs).toEqual([])
                })

                sub.once('resendComplete', onResent)

                for await (const msg of sub) {
                    receivedMsgs.push(msg)
                    if (receivedMsgs.length === publishedStream2.length) {
                        break
                    }
                }

                expect(receivedMsgs).toHaveLength(publishedStream2.length)
                expect(receivedMsgs).toEqual(publishedStream2)
                expect(onResent).toHaveBeenCalledTimes(1)
                expect(await client.getSubscriptions(stream.id)).toHaveLength(0)
            })
        })
    })

    describe('with resend data', () => {
        let published: StreamMessage[]
        beforeEach(async () => {
            if (published && published.length) { return }
            // eslint-disable-next-line require-atomic-updates
            published = await publishTestMessages(MAX_MESSAGES)
        }, WAIT_FOR_STORAGE_TIMEOUT * 2)

        beforeEach(async () => {
            await client.connect()
            // ensure last message is in storage
            await waitForStorage(published[published.length - 1])
        }, WAIT_FOR_STORAGE_TIMEOUT * 2)

        it('gives zero results for last 0', async () => {
            const sub = await subscriber.resend({
                streamId: stream.id,
                partition: 0,
            }, {
                last: 0
            })
            const receivedMsgs = await sub.collect()
            expect(receivedMsgs).toHaveLength(0)
        })

        describe('last', () => {
            it('can resend all', async () => {
                const sub = await subscriber.resend({
                    streamId: stream.id,
                    partition: 0,
                }, {
                    last: published.length
                })

                const receivedMsgs = await sub.collect()
                expect(receivedMsgs).toHaveLength(published.length)
                expect(receivedMsgs.map((s) => s.toObject())).toEqual(published.map((s) => s.toObject()))
            })

            it('can resend subset', async () => {
                const sub = await subscriber.resend({
                    streamId: stream.id,
                    partition: 0
                }, {
                    last: 2
                })

                const receivedMsgs = await sub.collect()
                expect(receivedMsgs).toHaveLength(2)
                expect(receivedMsgs.map((s) => s.toObject())).toEqual(published.slice(-2).map((s) => s.toObject()))
            })
        })

        describe('from', () => {
            it('can resend all', async () => {
                const sub = await subscriber.resend({
                    streamId: stream.id,
                    partition: 0,
                }, {
                    from: {
                        timestamp: published[0].getTimestamp(),
                    }
                })

                const receivedMsgs = await sub.collect()
                expect(receivedMsgs).toHaveLength(published.length)
                expect(receivedMsgs.map((s) => s.toObject())).toEqual(published.map((s) => s.toObject()))
            })

            it('can resend subset', async () => {
                const sub = await subscriber.resend({
                    streamId: stream.id,
                    partition: 0,
                }, {
                    from: {
                        timestamp: published[2].getTimestamp(),
                    }
                })

                const receivedMsgs = await sub.collect()
                expect(receivedMsgs).toHaveLength(MAX_MESSAGES - 2)
                expect(receivedMsgs.map((s) => s.toObject())).toEqual(published.slice(2).map((s) => s.toObject()))
            })
        })

        describe('range', () => {
            it('can resend all', async () => {
                const sub = await subscriber.resend({
                    streamId: stream.id,
                    partition: 0,
                }, {
                    from: {
                        timestamp: published[0].getTimestamp(),
                    },
                    to: {
                        timestamp: published[published.length - 1].getTimestamp(),
                    }
                })

                const receivedMsgs = await sub.collect()
                expect(receivedMsgs).toHaveLength(published.length)
                expect(receivedMsgs.map((s) => s.toObject())).toEqual(published.map((s) => s.toObject()))
            })

            it('can resend subset', async () => {
                const sub = await subscriber.resend({
                    streamId: stream.id,
                    partition: 0,
                }, {
                    from: {
                        timestamp: published[2].getTimestamp(),
                    },
                    to: {
                        timestamp: published[3].getTimestamp(),
                    }
                })

                const receivedMsgs = await sub.collect()
                expect(receivedMsgs).toHaveLength(2)
                expect(receivedMsgs.map((s) => s.toObject())).toEqual(published.slice(2, 4).map((s) => s.toObject()))
            })
        })

        it('can resend with onMessage callback', async () => {
            const receivedMsgs: any[] = []
            const sub = await subscriber.resend({
                streamId: stream.id,
                partition: 0,
            }, {
                from: {
                    timestamp: published[0].getTimestamp(),
                }
            }, (_msg, streamMessage) => {
                receivedMsgs.push(streamMessage)
            })

            await sub.onFinally.listen()
            expect(receivedMsgs).toHaveLength(published.length)
            expect(receivedMsgs.map((s) => s.toObject())).toEqual(published.map((s) => s.toObject()))
        })

        describe('resendSubscribe', () => {
            it('sees resends and realtime', async () => {
                const sub = await client.subscribe({
                    streamId: stream.id,
                    resend: {
                        last: published.length
                    }
                })
                expect(await client.getSubscriptions(stream.id)).toHaveLength(1)

                const onResent = jest.fn()
                sub.once('resendComplete', onResent)

                // eslint-disable-next-line no-await-in-loop
                published.push(...await publishTestMessages(2))

                const receivedMsgs = await sub.collect(published.length)

                expect(receivedMsgs).toHaveLength(published.length)
                expect(onResent).toHaveBeenCalledTimes(1)
                expect(receivedMsgs).toEqual(published)
                expect(await client.getSubscriptions(stream.id)).toHaveLength(0)
            })

            it('client.subscribe works as regular subscribe when just passing streamId as string', async () => {
                const sub = await client.subscribe(stream.id)
                expect(await client.getSubscriptions(stream.id)).toHaveLength(1)

                published.push(...await publishTestMessages(2))

                const received = await sub.collect(2)
                expect(received).toEqual(published.slice(-2))
            })

            it('sees resends when no realtime', async () => {
                const sub = await client.subscribe({
                    streamId: stream.id,
                    resend: {
                        last: published.length,
                    }
                })

                const publishedBefore = published.slice()
                const receivedMsgs: any[] = []

                const onResent = jest.fn(() => {
                    expect(receivedMsgs).toEqual(publishedBefore)
                })

                sub.once('resendComplete', onResent)

                for await (const msg of sub) {
                    receivedMsgs.push(msg)
                    if (receivedMsgs.length === published.length) {
                        await sub.return()
                    }
                }

                expect(receivedMsgs).toHaveLength(published.length)
                expect(receivedMsgs).toEqual(published)
                expect(await client.getSubscriptions(stream.id)).toHaveLength(0)
            })

            it('ends resend if unsubscribed', async () => {
                const sub = await client.subscribe({
                    streamId: stream.id,
                    resend: {
                        last: published.length,
                    }
                })

                const END_AFTER = 3
                // eslint-disable-next-line no-await-in-loop
                published.push(...await publishTestMessages(2))
                const receivedMsgs = await sub.forEach(async (_msg, index) => {
                    if (index === END_AFTER - 1) {
                        sub.unsubscribe()
                    }
                }).collect()

                const msgs = receivedMsgs
                expect(msgs).toHaveLength(END_AFTER)
                expect(msgs).toEqual(published.slice(0, END_AFTER))
                expect(await client.getSubscriptions(stream.id)).toHaveLength(0)
            })

            it('can return before start', async () => {
                const sub = await client.subscribe({
                    streamId: stream.id,
                    resend: {
                        last: published.length
                    }
                })

                expect(await client.getSubscriptions(stream.id)).toHaveLength(1)

                await sub.return()
                published.push(...await publishTestMessages(2))
                const received = await sub.collect(published.length)
                expect(received).toHaveLength(0)
                expect(await client.getSubscriptions(stream.id)).toHaveLength(0)
            })

            it('can end asynchronously', async () => {
                const sub = await client.subscribe({
                    streamId: stream.id,
                    resend: {
                        last: published.length
                    }
                })

                published.push(...await publishTestMessages(2))

                let t!: ReturnType<typeof setTimeout>
                const received = []
                try {
                    for await (const m of sub) {
                        received.push(m)
                        if (received.length === published.length) {
                            t = setTimeout(() => {
                                sub.unsubscribe()
                            })
                        }
                    }
                } finally {
                    clearTimeout(t)
                }

                const msgs = received
                expect(msgs).toHaveLength(published.length)
                expect(msgs).toEqual(published)
                expect(await client.getSubscriptions(stream.id)).toHaveLength(0)
            })

            it('can end inside resend', async () => {
                const sub = await client.subscribe({
                    streamId: stream.id,
                    resend: {
                        last: published.length
                    }
                })

                published.push(...await publishTestMessages(2))
                const END_AFTER = 3
                const receivedMsgs: any[] = []
                for await (const msg of sub) {
                    receivedMsgs.push(msg)
                    if (receivedMsgs.length === END_AFTER) {
                        await sub.unsubscribe()
                    }
                }

                const msgs = receivedMsgs
                expect(msgs).toHaveLength(END_AFTER)
                expect(msgs).toEqual(published.slice(0, END_AFTER))
                expect(await client.getSubscriptions(stream.id)).toHaveLength(0)
            })

            it('does not error if no storage assigned', async () => {
                const nonStoredStream = await createTestStream(client, module)
                const sub = await client.subscribe({
                    streamId: nonStoredStream.id,
                    resend: {
                        last: 5
                    }
                })
                expect(await client.getSubscriptions(nonStoredStream.id)).toHaveLength(1)

                const onResent = jest.fn()
                sub.once('resendComplete', onResent)

                const publishedMessages = await getPublishTestStreamMessages(client, nonStoredStream.id)(2)

                const receivedMsgs = await sub.collect(publishedMessages.length)
                expect(receivedMsgs).toHaveLength(publishedMessages.length)
                expect(onResent).toHaveBeenCalledTimes(1)
                expect(receivedMsgs).toEqual(publishedMessages)
                expect(await client.getSubscriptions(nonStoredStream.id)).toHaveLength(0)
            })
        })
    })

    it('decodes resent messages correctly', async () => {
        const publishedMessage = Msg({
            content: fs.readFileSync(path.join(__dirname, 'utf8Example.txt'), 'utf8')
        })
        const publishReq = await client.publish(stream, publishedMessage)

        await getWaitForStorage(client)(publishReq)
        const sub = await client.resend(stream.id,
            {
                last: 1
            })
        const messages = await sub.collectContent()
        expect(messages).toEqual([publishedMessage])
    })
})
