import { wait, waitForCondition } from 'streamr-test-utils'

import { createTestStream, getCreateClient } from '../test-utils/utils'
import { getPublishTestMessages } from '../test-utils/publish'
import { StreamrClient } from '../../src/StreamrClient'

import { Stream } from '../../src/Stream'
import { range } from 'lodash'

const NUM_MESSAGES = 8
const MAX_MESSAGES = 4
const PARTITIONS = 3
jest.setTimeout(60000)

describe.skip('SubscribeAll', () => { // TODO enable the test when it doesn't depend on PublishPipeline (via getPublishTestMessages)
    let expectErrors = 0 // check no errors by default
    let onError = jest.fn()
    let client: StreamrClient
    let stream: Stream
    let publishTestMessages: ReturnType<typeof getPublishTestMessages>

    const createClient = getCreateClient()

    beforeEach(async () => {
        expectErrors = 0
        onError = jest.fn()
    })

    beforeEach(async () => {
        // eslint-disable-next-line require-atomic-updates
        client = await createClient()
        await client.connect()
        stream = await createTestStream(client, module, {
            partitions: PARTITIONS,
        })
        publishTestMessages = getPublishTestMessages(client, stream)
    })

    afterEach(async () => {
        // @ts-expect-error private
        expect(await client.subscriber.count()).toBe(0)
        // @ts-expect-error private
        expect(await client.subscriber.count(stream.id)).toBe(0)
        // @ts-expect-error private
        expect(client.subscriber.countSubscriptionSessions()).toBe(0)
    })

    afterEach(async () => {
        await wait(0)
        await client?.destroy()
        // ensure no unexpected errors
        expect(onError).toHaveBeenCalledTimes(expectErrors)
    })

    it('subscribes to all partitions', async () => {
        const subMsgs: any[] = []
        await client.subscribeAll(stream.id, (msg) => {
            subMsgs.push(msg)
        })
        const pubs = await Promise.all(range(PARTITIONS).map((streamPartition) => {
            return publishTestMessages(NUM_MESSAGES, { partitionKey: streamPartition })
        }))
        const publishedMsgs = pubs.flat()
        expect(publishedMsgs.length).toBe(PARTITIONS * NUM_MESSAGES)
        await waitForCondition(() => subMsgs.length >= (PARTITIONS * NUM_MESSAGES), 25000)
        for (const msg of publishedMsgs) {
            expect(subMsgs).toContainEqual(msg)
        }
        await client.unsubscribe()
        expect(await client.getSubscriptions()).toHaveLength(0)
    })

    it('works with single partition', async () => {
        const subMsgs: any[] = []
        stream = await createTestStream(client, module, {
            partitions: 1
        })
        publishTestMessages = getPublishTestMessages(client, stream)

        await client.subscribeAll(stream.id, (msg) => {
            subMsgs.push(msg)
        })

        const pubs = await Promise.all([0].map((streamPartition) => {
            return publishTestMessages(NUM_MESSAGES, { partitionKey: streamPartition })
        }))
        const publishedMsgs = pubs.flat()
        expect(publishedMsgs.length).toBe(NUM_MESSAGES)
        await waitForCondition(() => subMsgs.length >= (NUM_MESSAGES), 25000)
        for (const msg of publishedMsgs) {
            expect(subMsgs).toContainEqual(msg)
        }
        await client.unsubscribe()
        expect(await client.getSubscriptions()).toHaveLength(0)
    })

    it('can stop prematurely', async () => {
        const subMsgs: any[] = []
        const sub = await client.subscribeAll(stream.id, (msg) => {
            subMsgs.push(msg)
            if (subMsgs.length === MAX_MESSAGES) {
                sub.return()
            }
        })
        const pubs = await Promise.all(range(PARTITIONS).map((streamPartition) => {
            return publishTestMessages(NUM_MESSAGES, { partitionKey: streamPartition })
        }))
        const publishedMsgs = pubs.flat()
        expect(publishedMsgs.length).toBe(PARTITIONS * NUM_MESSAGES)
        await sub.onFinally.listen()
        await wait(500) // TODO: why is this wait needed? wasn't needed before encryption was enabled.
        // got the messages
        expect(subMsgs).toHaveLength(MAX_MESSAGES)
        // unsubscribed from everything
        expect((await client.getSubscriptions(stream.id)).length).toBe(0)
    })

    it('stops with unsubscribeAll', async () => {
        const subMsgs: any[] = []
        const sub = await client.subscribeAll(stream.id, (msg) => {
            subMsgs.push(msg)
            if (subMsgs.length === MAX_MESSAGES) {
                client.unsubscribe()
            }
        })
        const pubs = await Promise.all(range(PARTITIONS).map((streamPartition) => {
            return publishTestMessages(NUM_MESSAGES, { partitionKey: streamPartition })
        }))
        const publishedMsgs = pubs.flat()
        expect(publishedMsgs.length).toBe(PARTITIONS * NUM_MESSAGES)
        await sub.onFinally.listen()
        // got the messages
        expect(subMsgs).toHaveLength(MAX_MESSAGES)
        // unsubscribed from everything
        expect(await client.getSubscriptions()).toHaveLength(0)
    })

    it('stops only when all subs are unsubbed', async () => {
        const subMsgs: any[] = []
        const sub = await client.subscribeAll(stream.id, (msg) => {
            subMsgs.push(msg)
        })
        const onFinallyCalled = jest.fn()
        sub.onFinally.listen(onFinallyCalled)

        const pubs = await Promise.all(range(PARTITIONS).map((streamPartition) => {
            return publishTestMessages(NUM_MESSAGES, { partitionKey: streamPartition })
        }))
        const publishedMsgs = pubs.flat()
        expect(publishedMsgs.length).toBe(PARTITIONS * NUM_MESSAGES)
        await waitForCondition(() => subMsgs.length >= (PARTITIONS * NUM_MESSAGES), 25000)
        expect(onFinallyCalled).toHaveBeenCalledTimes(0)
        // unsub from each partition
        // should only call onFinally once all unsubbed
        for (const p of range(PARTITIONS)) {
            expect(onFinallyCalled).toHaveBeenCalledTimes(0)
            // eslint-disable-next-line no-await-in-loop
            await client.unsubscribe({ streamId: stream.id, partition: p })
        }

        // should have ended after last partition unsubbed
        expect(onFinallyCalled).toHaveBeenCalledTimes(1)

        for (const msg of publishedMsgs) {
            expect(subMsgs).toContainEqual(msg)
        }
        // got the messages
        expect(subMsgs.length).toBe(PARTITIONS * NUM_MESSAGES)
        // unsubscribed from everything
        expect((await client.getSubscriptions(stream.id)).length).toBe(0)
    })
})
