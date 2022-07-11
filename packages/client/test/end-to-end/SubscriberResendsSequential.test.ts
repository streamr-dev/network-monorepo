import { createTestStream } from '../test-utils/utils'
import { getPublishTestStreamMessages, getWaitForStorage, Msg } from '../test-utils/publish'
import { StreamrClient } from '../../src/StreamrClient'
import { ConfigTest, DOCKER_DEV_STORAGE_NODE } from '../../src/ConfigTest'
import { Stream } from '../../src/Stream'
import { StreamPermission } from '../../src/permission'
import { fetchPrivateKeyWithGas } from 'streamr-test-utils'

const WAIT_FOR_STORAGE_TIMEOUT = process.env.CI ? 24000 : 12000
const MAX_MESSAGES = 5
const ITERATIONS = 4

jest.setTimeout(30000)

describe.skip('sequential resend subscribe', () => { // TODO enable the test when it doesn't depend on PublishPipeline (via getPublishTestStreamMessages)
    let publisher: StreamrClient
    let subscriber: StreamrClient
    let stream: Stream

    let publishTestMessages: ReturnType<typeof getPublishTestStreamMessages>
    let waitForStorage: (...args: any[]) => Promise<void> = async () => {}

    let published: any[] = [] // keeps track of stream message data so we can verify they were resent

    beforeAll(async () => {
        publisher = new StreamrClient({
            ...ConfigTest,
            id: 'TestPublisher',
            auth: {
                privateKey: await fetchPrivateKeyWithGas(),
            },
        })

        subscriber = new StreamrClient({
            ...ConfigTest,
            id: 'TestSubscriber',
            auth: {
                privateKey: await fetchPrivateKeyWithGas(),
            },
        })

        stream = await createTestStream(publisher, module)
        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], public: true })
        await stream.addToStorageNode(DOCKER_DEV_STORAGE_NODE)

        publishTestMessages = getPublishTestStreamMessages(publisher, stream)
        await stream.grantPermissions({
            user: await subscriber.getAddress(),
            permissions: [StreamPermission.SUBSCRIBE]
        })

        waitForStorage = getWaitForStorage(publisher, {
            stream,
            timeout: WAIT_FOR_STORAGE_TIMEOUT,
        })

        // initialize resend data by publishing some messages and waiting for
        // them to land in storage
        published = await publishTestMessages(MAX_MESSAGES, {
            waitForLast: true,
            timestamp: 111111,
        })

    }, WAIT_FOR_STORAGE_TIMEOUT * 2)

    afterAll(async () => {
        await publisher?.destroy()
        await subscriber?.destroy()
    })

    afterEach(async () => {
        // ensure last message is in storage
        const last = published[published.length - 1]
        await waitForStorage(last)
    })

    for (let i = 0; i < ITERATIONS; i++) {
        // keep track of which messages were published in previous tests
        // so we can check that they exist in resends of subsequent tests
        // publish messages with timestamps like 222222, 333333, etc so the
        // sequencing is clearly visible in logs
        const id = (i + 2) * 111111 // start at 222222
        // eslint-disable-next-line no-loop-func
        test(`test ${id}`, async () => {
            const sub = await subscriber.subscribe({
                streamId: stream.id,
                resend: {
                    last: published.length,
                }
            })

            const onResent = jest.fn()
            sub.once('resendComplete', onResent)

            const message = Msg()
            // eslint-disable-next-line no-await-in-loop
            const streamMessage = await publisher.publish(stream.id, message, { // should be realtime
                timestamp: id
            })
            // keep track of published messages so we can check they are resent in next test(s)
            published.push(streamMessage)
            const msgs = await sub.collect(published.length)
            expect(msgs).toHaveLength(published.length)
            expect(msgs).toEqual(published)
        })
    }
})
