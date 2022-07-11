import fs from 'fs'
import path from 'path'
import { MessageLayer, StreamPartID, toStreamID, toStreamPartID } from 'streamr-client-protocol'
import { fastPrivateKey, wait } from 'streamr-test-utils'
import {
    getCreateClient,
    createPartitionedTestStream,
    createStreamPartIterator,
    toStreamDefinition
} from '../test-utils/utils'
import {
    Msg,
    getPublishTestMessages,
    publishManyGenerator
} from '../test-utils/publish'
import { describeRepeats } from '../test-utils/jest-utils'
import { StreamrClient } from '../../src/StreamrClient'
import { Defer } from '../../src/utils/Defer'
import * as G from '../../src/utils/GeneratorUtils'
import { PublishPipeline } from '../../src/publish/PublishPipeline'

jest.setTimeout(60000)

const { StreamMessage } = MessageLayer

const MAX_MESSAGES = 10
const TIMEOUT = 30 * 1000
const WAIT_TIME = 600

describeRepeats.skip('StreamrClient', () => { // TODO enable the test when it doesn't depend on PublishPipeline
    let expectErrors = 0 // check no errors by default
    let errors: any[] = []

    const getOnError = (errs: any) => jest.fn((err) => {
        errs.push(err)
    })

    let onError = jest.fn()
    let client: StreamrClient
    let privateKey: string
    const createClient = getCreateClient()
    let publishTestMessages: ReturnType<typeof getPublishTestMessages>

    let streamParts: AsyncGenerator<StreamPartID>
    let streamDefinition: { id: string, partition: number }

    beforeAll(async () => {
        const stream = await createPartitionedTestStream(module)
        streamParts = createStreamPartIterator(stream)
    })

    beforeEach(async () => {
        streamDefinition = toStreamDefinition((await (await streamParts.next()).value))
        errors = []
        expectErrors = 0
        onError = getOnError(errors)
    })

    afterEach(async () => {
        await wait(0)
        // ensure no unexpected errors
        expect(errors).toHaveLength(expectErrors)
    })

    beforeEach(async () => {
        privateKey = fastPrivateKey()
        client = await createClient({
            auth: {
                privateKey
            }
        })
        await client.connect()
        publishTestMessages = getPublishTestMessages(client, streamDefinition)
        expect(onError).toHaveBeenCalledTimes(0)
    })

    afterEach(async () => {
        await wait(0)
        // ensure no unexpected errors
        expect(onError).toHaveBeenCalledTimes(expectErrors)
    })

    describe('Pub/Sub', () => {
        it('client.publish does not error', async () => {
            await client.publish(streamDefinition, {
                test: 'client.publish',
            })
            await wait(WAIT_TIME)
        }, TIMEOUT)

        it('Stream.publish does not error', async () => {
            const stream = await client.getStream(streamDefinition.id)
            await stream.publish({
                test: 'Stream.publish',
            })
            await wait(WAIT_TIME)
        }, TIMEOUT)

        it('client.publish with Stream object as arg', async () => {
            const stream = await client.getStream(streamDefinition.id)
            await client.publish(stream, {
                test: 'client.publish.Stream.object',
            })
            await wait(WAIT_TIME)
        }, TIMEOUT)

        describe('subscribe/unsubscribe', () => {
            beforeEach(async () => {
                expect(await client.getSubscriptions()).toHaveLength(0)
            })

            it('client.subscribe then unsubscribe after subscribed', async () => {
                const subTask = client.subscribe<{ test: string }>(streamDefinition, () => {})
                // @ts-expect-error private
                expect(await client.subscriber.getSubscriptions()).toHaveLength(0) // does not have subscription yet

                const sub = await subTask

                expect(await client.getSubscriptions()).toHaveLength(1)
                await client.unsubscribe(sub)
                // @ts-expect-error private
                expect(await client.subscriber.getSubscriptions()).toHaveLength(0)
            }, TIMEOUT)

            it('client.subscribe then unsubscribe before subscribed', async () => {
                const subTask = client.subscribe(streamDefinition, () => {})

                expect(await client.getSubscriptions()).toHaveLength(0) // does not have subscription yet

                const unsubTask = client.unsubscribe(streamDefinition)

                expect(await client.getSubscriptions()).toHaveLength(0) // lost subscription immediately
                await unsubTask
                await subTask
                await wait(WAIT_TIME)
            }, TIMEOUT)
        })

        it('client.subscribe (realtime) with onMessage signal', async () => {
            const done = Defer()
            const msg = Msg()

            const sub = await client.subscribe<typeof msg>(streamDefinition)

            sub.onMessage.listen(done.wrap(async (streamMessage) => {
                sub.unsubscribe()
                const parsedContent = streamMessage.getParsedContent()
                expect(parsedContent).toEqual(msg)

                // Check signature stuff
                expect(streamMessage.signatureType).toBe(StreamMessage.SIGNATURE_TYPES.ETH)
                expect(streamMessage.getPublisherId()).toBeTruthy()
                expect(streamMessage.signature).toBeTruthy()
            }))

            // Publish after subscribed
            await client.publish(streamDefinition, msg)
            await sub.consume()
            await done
        })

        it('client.subscribe (realtime) with onMessage callback', async () => {
            const done = Defer()
            const msg = Msg()
            await client.subscribe<typeof msg>(streamDefinition, done.wrap(async (parsedContent, streamMessage) => {
                expect(parsedContent).toEqual(msg)

                // Check signature stuff
                expect(streamMessage.signatureType).toBe(StreamMessage.SIGNATURE_TYPES.ETH)
                expect(streamMessage.getPublisherId()).toBeTruthy()
                expect(streamMessage.signature).toBeTruthy()
            }))

            // Publish after subscribed
            await client.publish(streamDefinition, msg)
            await done
        })

        it('client.subscribe with onMessage & collect', async () => {
            const onMessageMsgs: any[] = []
            const done = Defer()
            const sub = await client.subscribe<typeof Msg>(streamDefinition, async (msg) => {
                onMessageMsgs.push(msg)
                if (onMessageMsgs.length === MAX_MESSAGES) {
                    done.resolve(undefined)
                }
            })

            const published = await publishTestMessages(MAX_MESSAGES)
            await expect(async () => sub.collect(1)).rejects.toThrow()
            await done
            expect(onMessageMsgs).toEqual(published)
        })

        it('client.subscribe with onMessage callback that throws', async () => {
            const onMessageMsgs: any[] = []
            const err = new Error('expected error')
            const sub = await client.subscribe<typeof Msg>(streamDefinition, async (msg) => {
                onMessageMsgs.push(msg)

                if (onMessageMsgs.length === MAX_MESSAGES) {
                    sub.return()
                }
                throw err
            })

            const onSubError = jest.fn()
            sub.onError.listen(onSubError)

            const published = await publishTestMessages(MAX_MESSAGES)
            await sub.onFinally.listen()
            expect(onMessageMsgs).toEqual(published.slice(0, 1))
            expect(onSubError).toHaveBeenCalledTimes(1)
            expect(onSubError).toHaveBeenCalledWith(err)
        })

        it('publish and subscribe a sequence of messages', async () => {
            const done = Defer()
            const received: typeof Msg[] = []
            const sub = await client.subscribe<typeof Msg>(streamDefinition, done.wrapError((parsedContent, streamMessage) => {
                received.push(parsedContent)
                // Check signature stuff
                expect(streamMessage.signatureType).toBe(StreamMessage.SIGNATURE_TYPES.ETH)
                expect(streamMessage.getPublisherId()).toBeTruthy()
                expect(streamMessage.signature).toBeTruthy()
                if (received.length === MAX_MESSAGES) {
                    done.resolve(client.unsubscribe(sub))
                }
            }))

            // Publish after subscribed
            const published = await publishTestMessages(MAX_MESSAGES)

            await done
            expect(received).toEqual(published)
        })

        it('destroying stops publish', async () => {
            const subscriber = await createClient({
                auth: {
                    privateKey
                }
            })
            const sub = await subscriber.subscribe(streamDefinition)

            const onMessage = jest.fn()
            const gotMessages = Defer()
            const published: any[] = []
            // @ts-expect-error private
            const publishPipeline = client.container.resolve(PublishPipeline)
            // @ts-expect-error private
            publishPipeline.publishQueue.onMessage.listen(async ([streamMessage]) => {
                const requiredStreamPartID = toStreamPartID(toStreamID(streamDefinition.id), streamDefinition.partition)
                if (requiredStreamPartID !== streamMessage.getStreamPartID()) { return }
                onMessage()
                published.push(streamMessage.getParsedContent())
                if (published.length === 3) {
                    await gotMessages
                    await client.destroy()
                }
            })

            const received: any[] = []
            const publishTask = (async () => {
                for (let i = 0; i < MAX_MESSAGES; i += 1) {
                    // eslint-disable-next-line no-await-in-loop
                    await client.publish(streamDefinition, Msg())
                }
            })()
            publishTask.catch(() => {})
            for await (const msg of sub) {
                received.push(msg)
                if (received.length === 3) {
                    gotMessages.resolve(undefined)
                    setTimeout(() => { sub.unsubscribe() }, 500)
                }
            }
            await expect(async () => {
                await publishTask
            }).rejects.toThrow('publish')
            expect(received.map((s) => s.getParsedContent())).toEqual(published.slice(0, 3))
            return expect(onMessage).toHaveBeenCalledTimes(3)
        })

        it('destroying resolves publish promises', async () => {
            // the subscriber side of this test is partially disabled as we
            // can't yet reliably publish messages then disconnect and know
            // that subscriber will actually get something.
            // Probably needs to wait for propagation.
            const subscriber = await createClient({
                auth: {
                    privateKey
                }
            })

            const received: any[] = []
            // const gotMessage = Defer()
            await subscriber.subscribe(streamDefinition, (msg) => {
                received.push(msg)
                // gotMessage.resolve(undefined)
            })

            const msgs = await G.collect(publishManyGenerator(MAX_MESSAGES))

            const publishTasks = [
                client.publish(streamDefinition, msgs[0]).finally(async () => {
                    await client.destroy()
                }),
                client.publish(streamDefinition, msgs[1]),
                client.publish(streamDefinition, msgs[2]),
                client.publish(streamDefinition, msgs[3]),
            ]
            const results = await Promise.allSettled(publishTasks)
            client.debug('publishTasks', results.map(({ status }) => status))
            expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected', 'rejected'])
            await wait(500)
            client.debug('received', received)
            // should probably get every publish that was fulfilled, right?
            // expect(received).toEqual([msgs[0].content])
        })

        it('cannot subscribe or publish after destroy', async () => {
            await client.destroy()
            await expect(async () => {
                await client.subscribe(streamDefinition)
            }).rejects.toThrow('destroy')
            await expect(async () => {
                await client.publish(streamDefinition, Msg())
            }).rejects.toThrow('destroy')
            await expect(async () => {
                await client.connect()
            }).rejects.toThrow('destroy')
        })
    })

    describe('utf-8 encoding', () => {
        it('decodes realtime messages correctly', async () => {
            const publishedMessage = Msg({
                content: fs.readFileSync(path.join(__dirname, 'utf8Example.txt'), 'utf8')
            })
            const sub = await client.subscribe(streamDefinition)
            await client.publish(streamDefinition, publishedMessage)
            const messages = await sub.collect(1)
            expect(messages.map((s) => s.getParsedContent())).toEqual([publishedMessage])
        })
    })
})

/*
            it('client.subscribe then unsubscribe before subscribed after started subscribing', async () => {
                const subTask = client.subscribe({
                    streamId: stream.id,
                }, () => {})
                const subSession = client.subscriber.getSubscriptionSession(stream)!
                let unsubTask!: ReturnType<typeof client.unsubscribe>
                const startedSubscribing = Defer()
                subSession.once('subscribing', startedSubscribing.wrap(() => {
                    unsubTask = client.unsubscribe(stream)
                }))

                await startedSubscribing
                await Promise.all([
                    unsubTask,
                    subTask,
                ])
                expect(await client.getSubscriptions()).toHaveLength(0) // lost subscription immediately
                await wait(WAIT_TIME)
                expect(events.onResent).toHaveBeenCalledTimes(0)
                expect(events.onSubscribed).toHaveBeenCalledTimes(0)
                expect(events.onUnsubscribed).toHaveBeenCalledTimes(1)
            }, TIMEOUT)

            describe('with resend', () => {
                it('client.subscribe then unsubscribe before subscribed', async () => {
                    client.connection.enableAutodestroy(false)
                    const subTask = client.subscribe({
                        streamId: stream.id,
                        resend: {
                            from: {
                                timestamp: 0,
                            },
                        },
                    }, () => {})

                    const events = attachSubListeners(client.subscriber.getSubscriptionSession(stream)!)

                    expect(await client.getSubscriptions()).toHaveLength(1)

                    const unsubTask = client.unsubscribe(stream)

                    expect(await client.getSubscriptions()).toHaveLength(0) // lost subscription immediately
                    await unsubTask
                    await subTask
                    await wait(WAIT_TIME * 2)
                    expect(events.onResent).toHaveBeenCalledTimes(0)
                    expect(events.onSubscribed).toHaveBeenCalledTimes(0)
                    expect(events.onUnsubscribed).toHaveBeenCalledTimes(0)
                }, TIMEOUT)

                it('client.subscribe then unsubscribe ignores messages with resend', async () => {
                    const onMessage = jest.fn()
                    const subTask = client.subscribe({
                        streamId: stream.id,
                        resend: {
                            from: {
                                timestamp: 0,
                            },
                        },
                    }, onMessage)

                    const events = attachSubListeners(client.subscriber.getSubscriptionSession(stream)!)
                    const unsubTask = client.unsubscribe(stream)
                    expect(await client.getSubscriptions()).toHaveLength(0) // lost subscription immediately

                    const msg = Msg()
                    const publishReq = await stream.publish(msg)
                    await waitForStorage(publishReq)

                    await unsubTask
                    await subTask
                    await wait(WAIT_TIME)
                    expect(events.onResent).toHaveBeenCalledTimes(0)
                    expect(events.onSubscribed).toHaveBeenCalledTimes(0)
                    expect(events.onUnsubscribed).toHaveBeenCalledTimes(0)
                    expect(onMessage).toHaveBeenCalledTimes(0)
                }, TIMEOUT)
            })

            it('client.subscribe then unsubscribe ignores messages', async () => {
                const onMessage = jest.fn()
                const sub = await client.subscribe({
                    streamId: stream.id,
                }, onMessage)

                expect(await client.getSubscriptions()).toHaveLength(1)
                const events = attachSubListeners(sub)
                const t = client.unsubscribe(sub)
                await stream.publish(Msg())
                await t
                expect(await client.getSubscriptions()).toHaveLength(0) // lost subscription immediately
                await wait(WAIT_TIME)
                expect(events.onResent).toHaveBeenCalledTimes(0)
                expect(events.onSubscribed).toHaveBeenCalledTimes(0)
                expect(events.onUnsubscribed).toHaveBeenCalledTimes(1)
            }, TIMEOUT)
        })

        test('publish does not disconnect after each message with autoDisconnect', async () => {
            await client.destroy()
            const onConnected = jest.fn()
            const onDisconnected = jest.fn()
            client.on('disconnected', onDisconnected)
            client.on('connected', onConnected)

            client.enableAutoConnect()
            client.enableAutodestroy()
            await publishTestMessages(3, {
                delay: 150,
            })

            expect(onConnected).toHaveBeenCalledTimes(1)
            expect(onDisconnected).toHaveBeenCalledTimes(1)
        })

        it('client.subscribe with resend from', async () => {
            const done = Defer()
            const published = await publishTestMessages(MAX_MESSAGES, {
                waitForLast: true,
            })

            const received: any[] = []

            const sub = await client.subscribe({
                streamId: stream.id,
                resend: {
                    from: {
                        timestamp: 0,
                    },
                },
            }, done.wrapError(async (parsedContent, streamMessage) => {
                received.push(parsedContent)

                // Check signature stuff
                expect(streamMessage.signatureType).toBe(StreamMessage.SIGNATURE_TYPES.ETH)
                expect(streamMessage.getPublisherId()).toBeTruthy()
                expect(streamMessage.signature).toBeTruthy()
                if (received.length === published.length) {
                    done.resolve(undefined)
                }
            }))

            await done
            expect(received).toEqual(published)
            // All good, unsubscribe
            await client.unsubscribe(sub)
            expect(await client.getSubscriptions()).toHaveLength(0)
        }, TIMEOUT)

        it('client.subscribe with resend last', async () => {
            const done = Defer()
            const published = await publishTestMessages(MAX_MESSAGES, {
                waitForLast: true,
            })

            const received: any[] = []

            const sub = await client.subscribe({
                streamId: stream.id,
                resend: {
                    last: 2
                },
            }, done.wrapError(async (parsedContent, streamMessage) => {
                received.push(parsedContent)
                // Check signature stuff
                expect(streamMessage.signatureType).toBe(StreamMessage.SIGNATURE_TYPES.ETH)
                expect(streamMessage.getPublisherId()).toBeTruthy()
                expect(streamMessage.signature).toBeTruthy()
                if (received.length === 2) {
                    done.resolve(undefined)
                }
            }))

            await done
            // All good, unsubscribe
            await client.unsubscribe(sub)
            expect(received).toEqual(published.slice(-2))
            expect(await client.getSubscriptions()).toHaveLength(0)
        }, TIMEOUT)

        it('client.subscribe (realtime with resend)', async () => {
            const done = Defer()
            const published = await publishTestMessages(MAX_MESSAGES, {
                waitForLast: true,
            })

            const received: any[] = []

            const sub = await client.subscribe({
                streamId: stream.id,
                resend: {
                    last: 2
                },
            }, done.wrapError(async (parsedContent, streamMessage) => {
                received.push(parsedContent)
                // Check signature stuff
                expect(streamMessage.signatureType).toBe(StreamMessage.SIGNATURE_TYPES.ETH)
                expect(streamMessage.getPublisherId()).toBeTruthy()
                expect(streamMessage.signature).toBeTruthy()
                if (received.length === 3) {
                    done.resolve(undefined)
                }
            }))

            const [msg] = await publishTestMessages(1)

            await done
            // All good, unsubscribe
            await client.unsubscribe(sub)
            expect(received).toEqual([...published.slice(-2), msg])
            expect(await client.getSubscriptions()).toHaveLength(0)
        }, TIMEOUT)
    })

})
*/
