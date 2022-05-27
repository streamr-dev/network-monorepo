import { fastPrivateKey, wait, waitForCondition } from 'streamr-test-utils'
import { createTestStream, fetchPrivateKeyWithGas } from '../test-utils/utils'
import { ConfigTest, Stream, StreamPermission, StreamrClient } from '../../src'
import { range } from 'lodash'
import { DOCKER_DEV_STORAGE_NODE } from '../../src/ConfigTest'

const NUM_OF_MESSAGES = 20
const MESSAGE_STORE_TIMEOUT = 9 * 1000
const TIMEOUT = 30 * 1000

describe('resend', () => {
    let publisherClient: StreamrClient
    let resendClient: StreamrClient

    beforeEach(async () => {
        publisherClient = new StreamrClient({
            ...ConfigTest,
            auth: {
                privateKey: await fetchPrivateKeyWithGas()
            }
        })
        resendClient = new StreamrClient({
            ...ConfigTest,
            auth: {
                privateKey: fastPrivateKey()
            }
        })
    }, TIMEOUT)

    afterEach(async () => {
        await Promise.allSettled([
            publisherClient?.destroy(),
            resendClient?.destroy(),
        ])
    }, TIMEOUT)

    describe('non-public stream', () => {
        let stream: Stream

        beforeEach(async () => {
            stream = await createTestStream(publisherClient, module, { partitions: 3 })
            await stream.grantPermissions({
                permissions: [StreamPermission.SUBSCRIBE],
                user: await resendClient.getAddress()
            })
            /*await stream.grantPermissions({
                permissions: [StreamPermission.SUBSCRIBE],
                public: true
            })*/
            await stream.addToStorageNode(DOCKER_DEV_STORAGE_NODE)

            for (const idx of range(NUM_OF_MESSAGES)) {
                const partition = idx % 3
                await publisherClient.publish({
                    id: stream.id,
                    partition,
                }, {
                    messageNoInPartition: Math.floor(idx / 3),
                    partition,
                    messageNo: idx
                })
            }
            await wait(MESSAGE_STORE_TIMEOUT)
        }, TIMEOUT)

        it('can request resend for all messages', async () => {
            const messages: unknown[] = []
            await resendClient.resendAll(stream.id, { last: NUM_OF_MESSAGES }, (msg) => {
                messages.push(msg)
            })
            await waitForCondition(
                () => messages.length >= NUM_OF_MESSAGES,
                TIMEOUT - 1000,
                250,
                () => `messages array length was ${messages.length}`
            )
            expect(messages).toHaveLength(NUM_OF_MESSAGES)
        }, TIMEOUT)
    })
})
