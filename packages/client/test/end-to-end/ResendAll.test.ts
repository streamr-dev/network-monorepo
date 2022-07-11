import { range } from 'lodash'
import { StreamMessage } from 'streamr-client-protocol'
import { fetchPrivateKeyWithGas } from 'streamr-test-utils'
import { ConfigTest, DOCKER_DEV_STORAGE_NODE } from '../../src/ConfigTest'
import { Stream } from '../../src/Stream'
import { StreamrClient } from '../../src/StreamrClient'
import { createTestStream } from '../test-utils/utils'
import { getPublishTestStreamMessages,getWaitForStorage } from '../test-utils/publish'
import { StreamPermission } from '../../src'

const NUM_MESSAGES = 8
const PARTITIONS = 3
const WAIT_FOR_STORAGE_TIMEOUT = process.env.CI ? 20000 : 10000

jest.setTimeout(60000)

describe.skip('ResendAll', () => { // TODO enable the test when it doesn't depend on PublishPipeline (via getPublishTestStreamMessages)
    let client: StreamrClient
    let stream: Stream
    let publishTestMessages: ReturnType<typeof getPublishTestStreamMessages>
    let waitForStorage: (...args: any[]) => Promise<void>

    beforeAll(async () => {
        client = new StreamrClient({
            ...ConfigTest,
            auth: {
                privateKey: await fetchPrivateKeyWithGas()
            }
        })

        // eslint-disable-next-line require-atomic-updates
        await client.connect()
    })

    // note: test order matters
    // reuses same stream across tests
    beforeAll(async () => {
        client.debug('createStream >>')
        stream = await createTestStream(client, module, {
            partitions: PARTITIONS,
        })
        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], public: true })
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

    afterAll(async () => {
        await client?.destroy()
    })

    // must run before publishing any data
    describe('no data', () => {
        it('handles nothing to resend', async () => {
            const sub = await client.resendAll(stream.id, {
                last: 5,
            })

            const receivedMsgs = await sub.collect()
            expect(receivedMsgs).toHaveLength(0)
        })
    })

    describe('with resend data', () => {
        let published: StreamMessage[]
        beforeEach(async () => {
            if (published && published.length) { return }

            const pubs = await Promise.all(range(PARTITIONS).map((streamPartition) => {
                return publishTestMessages(NUM_MESSAGES, { partitionKey: streamPartition })
            }))
            // eslint-disable-next-line require-atomic-updates
            published = pubs.flat()
        }, WAIT_FOR_STORAGE_TIMEOUT * 2)

        beforeEach(async () => {
            await client.connect()
            // ensure last message is in storage
            await waitForStorage(published[published.length - 1])
        }, WAIT_FOR_STORAGE_TIMEOUT * 2)

        it('gives zero results for last 0', async () => {
            const sub = await client.resendAll(stream.id, {
                last: 0
            })
            const receivedMsgs = await sub.collect()
            expect(receivedMsgs).toHaveLength(0)
        })

        describe('last', () => {
            it('can resend all', async () => {
                const sub = await client.resendAll(stream.id, {
                    last: published.length
                })

                const receivedMsgs = await sub.collect()
                expect(receivedMsgs).toHaveLength(published.length)
                for (const msg of published) {
                    expect(receivedMsgs).toContainEqual(msg)
                }
            })

            it('can resend subset', async () => {
                const sub = await client.resendAll(stream.id, {
                    last: 2
                })

                const receivedMsgs = await sub.collect()
                expect(receivedMsgs).toHaveLength(2 * PARTITIONS)
            })
        })
    })
})
