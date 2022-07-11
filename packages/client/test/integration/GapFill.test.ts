import { StreamMessage } from 'streamr-client-protocol'
import { wait } from 'streamr-test-utils'

import { StreamrClient } from '../../src/StreamrClient'
import { StreamrClientConfig } from '../../src/Config'
import { Stream } from '../../src/Stream'
import { Subscriber } from '../../src/subscribe/Subscriber'
import { Subscription } from '../../src/subscribe/Subscription'

import { createTestStream } from '../test-utils/utils'
import { getPublishTestStreamMessages, Msg } from '../test-utils/publish'
import { DOCKER_DEV_STORAGE_NODE } from '../../src/ConfigTest'
import { ClientFactory, createClientFactory } from '../test-utils/fake/fakeEnvironment'
import { StreamPermission } from '../../src'

const MAX_MESSAGES = 10
jest.setTimeout(50000)

function monkeypatchMessageHandler<T = any>(sub: Subscription<T>, fn: ((msg: StreamMessage<T>, count: number) => void | null)) {
    let count = 0
    // eslint-disable-next-line no-param-reassign
    // @ts-expect-error private
    sub.context.pipeline.pipeBefore(async function* DropMessages(src: AsyncGenerator<any>) {
        for await (const msg of src) {
            const result = fn(msg, count)
            count += 1
            if (result === null) {
                sub.debug('(%o) << Test Dropped Message %s: %o', count, msg)
                continue
            }
            yield msg
        }
    })
}

describe.skip('GapFill', () => { // TODO enable the test when it doesn't depend on PublishPipeline
    let expectErrors = 0 // check no errors by default
    let publishTestMessages: ReturnType<typeof getPublishTestStreamMessages>
    let onError = jest.fn()
    let client: StreamrClient
    let stream: Stream
    let subscriber: Subscriber
    let clientFactory: ClientFactory

    async function setupClient(opts: StreamrClientConfig) {
        // eslint-disable-next-line require-atomic-updates
        client = clientFactory.createClient({
            maxGapRequests: 20,
            gapFillTimeout: 500,
            retryResendAfter: 1000,
            ...opts
        })
        // @ts-expect-error private
        subscriber = client.subscriber
        client.debug('connecting before test >>')
        stream = await createTestStream(client, module)
        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], public: true })
        await stream.addToStorageNode(DOCKER_DEV_STORAGE_NODE)
        client.debug('connecting before test <<')
        publishTestMessages = getPublishTestStreamMessages(client, stream.id, { waitForLast: true })
        return client
    }

    beforeEach(async () => {
        clientFactory = createClientFactory()
        expectErrors = 0
        onError = jest.fn()
    })

    afterEach(async () => {
        if (!subscriber || !stream) { return }
        expect(await subscriber.count(stream.id)).toBe(0)
        if (!client) { return }
        const subscriptions = await subscriber.getSubscriptions()
        expect(subscriptions).toHaveLength(0)
    })

    afterEach(async () => {
        await wait(0)
        // ensure no unexpected errors
        expect(onError).toHaveBeenCalledTimes(expectErrors)
    })

    let subs: Subscription<any>[] = []

    beforeEach(async () => {
        const existingSubs = subs
        subs = []
        await Promise.all(existingSubs.map((sub) => (
            sub.return()
        )))
    })

    describe('filling gaps', () => {
        beforeEach(async () => {
            await setupClient({
                gapFillTimeout: 200,
                retryResendAfter: 200,
            })
            await client.connect()
        })

        describe('realtime (uses resend)', () => {
            it('can fill single gap', async () => {
                // @ts-expect-error private
                const calledResend = jest.spyOn(client.resends, 'range')
                const sub = await client.subscribe(stream.id)
                monkeypatchMessageHandler(sub, (msg, count) => {
                    if (count === 2) {
                        sub.debug('test dropping message %d:', count, msg)
                        return null
                    }
                    return undefined
                })

                expect(await subscriber.count(stream.id)).toBe(1)

                const published = await publishTestMessages(MAX_MESSAGES)

                const received = []
                for await (const m of sub) {
                    received.push(m)
                    if (received.length === published.length) {
                        break
                    }
                }
                expect(received).toEqual(published)
                // might be > 1, depends whether messages in storage by time gap is requested.
                // message pipeline is processed as soon as messages arrive,
                // not when sub starts iterating
                expect(calledResend).toHaveBeenCalled()
            })

            it('can fill gap of multiple messages', async () => {
                const sub = await client.subscribe(stream.id)
                monkeypatchMessageHandler(sub, (_msg, count) => {
                    if (count > 1 && count < 4) { return null }
                    return undefined
                })

                expect(await subscriber.count(stream.id)).toBe(1)

                const published = await publishTestMessages(MAX_MESSAGES)

                const received = []
                for await (const m of sub) {
                    received.push(m)
                    if (received.length === published.length) {
                        break
                    }
                }
                expect(received).toEqual(published)
            })

            it('can fill multiple gaps', async () => {
                const sub = await client.subscribe(stream.id)

                monkeypatchMessageHandler(sub, (_msg, count) => {
                    if (count === 3 || count === 4 || count === 7) { return null }
                    return undefined
                })

                expect(await subscriber.count(stream.id)).toBe(1)

                const published = await publishTestMessages(MAX_MESSAGES)

                const received = []
                for await (const m of sub) {
                    received.push(m)
                    if (received.length === published.length) {
                        break
                    }
                }
                expect(received).toEqual(published)
            })
        })

        describe('resend', () => {
            it('can fill gaps', async () => {
                let count = 0
                const published = await publishTestMessages(MAX_MESSAGES, {
                    waitForLast: true,
                })

                const sub = await client.resend<typeof Msg>(
                    stream.id,
                    {
                        last: MAX_MESSAGES
                    }
                )

                sub.pipeBefore(async function* DropMessages(src) {
                    for await (const msg of src) {
                        count += 1
                        if (count === 3 || count === 4 || count === 7) {
                            continue
                        }
                        yield msg
                    }
                })

                const received = []
                for await (const m of sub) {
                    received.push(m)
                    // should not need to explicitly end
                }
                expect(received).toEqual(published)
            })

            it('can fill gaps in resends even if gap cannot be filled (ignores missing)', async () => {
                let ts = 0
                const node = await client.getNode()
                let publishCount = 1000
                const publish = node.publish.bind(node)
                node.publish = (msg) => {
                    publishCount += 1
                    if (publishCount === 1003) {
                        return undefined
                    }

                    return publish(msg)
                }

                const published = await publishTestMessages(MAX_MESSAGES, {
                    waitForLast: true,
                    timestamp: () => {
                        const v = 1000000 + ts
                        ts += 1
                        return v
                    }
                })

                const sub = await client.resend(
                    stream.id,
                    {
                        last: MAX_MESSAGES
                    }
                )

                const received = []
                for await (const m of sub) {
                    received.push(m)
                    // should not need to explicitly end
                }
                expect(received).toEqual(published.filter((_value: any, index: number) => index !== 2))
            })

            it('rejects resend if no storage assigned', async () => {
                // new stream, assign to storage node not called
                stream = await createTestStream(client, module)

                await expect(async () => {
                    await client.resend(
                        stream.id,
                        {
                            last: MAX_MESSAGES
                        }
                    )
                }).rejects.toThrow('storage')
            })
        })
    })

    describe('client settings', () => {
        it('ignores gaps if orderMessages disabled', async () => {
            await setupClient({
                orderMessages: false, // should disable all gapfilling
                gapFillTimeout: 200,
                retryResendAfter: 1000,
                maxGapRequests: 99 // would time out test if doesn't give up
            })

            // @ts-expect-error private
            const calledResend = jest.spyOn(client.resends, 'range')

            const node = await client.getNode()
            let publishCount = 0
            const publish = node.publish.bind(node)
            node.publish = (msg) => {
                publishCount += 1
                if (publishCount === 3) {
                    return undefined
                }

                return publish(msg)
            }

            const sub = await client.subscribe({
                id: stream.id
            })

            const publishedTask = publishTestMessages(MAX_MESSAGES)

            const received: any[] = []
            for await (const m of sub) {
                received.push(m)
                if (received.length === MAX_MESSAGES - 1) {
                    break
                }
            }
            const published = await publishedTask
            expect(received).toEqual(published.filter((_value: any, index: number) => index !== 2))
            expect(calledResend).toHaveBeenCalledTimes(0)
        })

        it('calls gapfill max maxGapRequests times', async () => {
            await setupClient({
                gapFillTimeout: 200,
                retryResendAfter: 200,
                maxGapRequests: 3
            })

            await client.connect()

            // @ts-expect-error private
            const calledResend = jest.spyOn(client.resends, 'range')
            const node = await client.getNode()
            let publishCount = 0
            const publish = node.publish.bind(node)
            node.publish = (msg) => {
                publishCount += 1
                if (publishCount === 3) {
                    return undefined
                }

                return publish(msg)
            }

            const published = await publishTestMessages(MAX_MESSAGES, {
                waitForLast: true,
            })

            const sub = await client.resend(
                stream.id,
                {
                    last: MAX_MESSAGES
                }
            )

            const received: any[] = []
            for await (const m of sub) {
                received.push(m)
                if (received.length === MAX_MESSAGES - 1) {
                    break
                }
            }
            expect(received).toEqual(published.filter((_value: any, index: number) => index !== 2))
            expect(calledResend).toHaveBeenCalledTimes(2 * 3) // another 3 come from resend done in publishTestMessages
        })
    })
})

// it('can fill gaps between resend and realtime', async () => {
// // publish 5 messages into storage
// const published = await publishTestMessages(5, {
// waitForLast: true,
// waitForLastCount: 5,
// })

// // then simultaneously subscribe with resend & start publishing realtime messages
// const [sub, publishedLater] = await Promise.all([
// client.subscribe({
// stream,
// resend: {
// last: 5
// }
// }),
// publishTestMessages(5)
// ])

// const received = []
// for await (const m of sub) {
// received.push(m.getParsedContent())
// if (received.length === (published.length + publishedLater.length)) {
// break
// }
// }

// expect(received).toEqual([...published, ...publishedLater])
// await sub.unsubscribe()
// }, 15000)

// it('rejects resend if no storage assigned', async () => {
// // new stream, assign to storage node not called
// stream = await createTestStream(client, module, {
// requireSignedData: true,
// })

// await expect(async () => {
// await client.resend({
// stream,
// last: MAX_MESSAGES,
// })
// }).rejects.toThrow('storage')
// }, 15000)
// })
// })

// describe('client settings', () => {
// it('can gapfill subscribe', async () => {
// await setupClient({
// gapFillTimeout: 200,
// retryResendAfter: 200,
// })
// await client.connect()
// const { parse } = client.connection
// let count = 0
// let droppedMsgRef: MessageRef
// client.connection.parse = (...args) => {
// const msg: any = parse.call(client.connection, ...args)
// if (!msg.streamMessage) {
// return msg
// }

// count += 1
// if (count === 3) {
// if (!droppedMsgRef) {
// droppedMsgRef = msg.streamMessage.getMessageRef()
// }
// client.debug('(%o) << Test Dropped Message %s: %o', client.connection.getState(), count, msg)
// return null
// }
// // allow resend request response through

// return msg
// }

// const sub = await client.subscribe({
// stream,
// })

// const publishedTask = publishTestMessages(MAX_MESSAGES, {
// stream,
// })

// const received: any[] = []
// for await (const m of sub) {
// received.push(m.getParsedContent())
// if (received.length === MAX_MESSAGES) {
// break
// }
// }
// const published = await publishedTask
// expect(received).toEqual(published)
// }, 20000)

// it('subscribe does not crash if gaps found but no storage assigned', async () => {
// await setupClient({
// gapFillTimeout: 200,
// retryResendAfter: 2000,
// maxGapRequests: 99 // would time out test if doesn't give up when seeing no storage assigned
// })

// await client.connect()
// const { parse } = client.connection
// // new stream, assign to storage node not called
// stream = await createTestStream(client, module, {
// requireSignedData: true,
// })
// const calledResend = jest.fn()
// let count = 0
// let droppedMsgRef: MessageRef
// client.connection.parse = (...args) => {
// const msg: any = parse.call(client.connection, ...args)
// if (!msg.streamMessage) {
// return msg
// }

// count += 1
// if (count === 3) {
// if (!droppedMsgRef) {
// droppedMsgRef = msg.streamMessage.getMessageRef()
// }
// client.debug('(%o) << Test Dropped Message %s: %o', client.connection.getState(), count, msg)
// return null
// }

// if (droppedMsgRef && msg.streamMessage.getMessageRef().compareTo(droppedMsgRef) === 0) {
// calledResend()
// client.debug('(%o) << Test Dropped Message %s: %o', client.connection.getState(), count, msg)
// return null
// }

// return msg
// }

// const sub = await client.subscribe({
// stream,
// })

// const publishedTask = publishTestMessages(MAX_MESSAGES, {
// stream,
// })

// const received: any[] = []
// for await (const m of sub) {
// received.push(m.getParsedContent())
// if (received.length === MAX_MESSAGES - 1) {
// break
// }
// }
// const published = await publishedTask
// expect(received).toEqual(published.filter((_value: any, index: number) => index !== 2))
// expect(client.connection.getState()).toBe('connected')
// // shouldn't retry if encountered no storage error
// expect(calledResend).toHaveBeenCalledTimes(0)
// }, 20000)

// it('subscribe+resend does not crash if no storage assigned', async () => {
// await setupClient({
// gapFillTimeout: 200,
// retryResendAfter: 2000,
// maxGapRequests: 99 // would time out test if doesn't give up when seeing no storage assigned
// })

// await client.connect()
// // new stream, assign to storage node not called
// stream = await createTestStream(client, module, {
// requireSignedData: true,
// })

// const sub = await client.subscribe({
// stream,
// resend: { last: 2 }
// })

// const publishedTask = publishTestMessages(MAX_MESSAGES, {
// stream,
// })

// const received: any[] = []
// for await (const m of sub) {
// received.push(m.getParsedContent())
// if (received.length === MAX_MESSAGES) {
// break
// }
// }
// const published = await publishedTask
// expect(received).toEqual(published)
// }, 20000)

// })
// })
