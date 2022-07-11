import { StreamrClient } from '../../src/StreamrClient'
import { Stream } from '../../src/Stream'
import { createTestStream } from '../test-utils/utils'
import { getPublishTestMessages } from '../test-utils/publish'
import { createClientFactory } from '../test-utils/fake/fakeEnvironment'

import { DOCKER_DEV_STORAGE_NODE } from '../../src/ConfigTest'

const DUMMY_ADDRESS = '0x1230000000000000000000000000000000000000'

describe.skip('Stream', () => { // TODO enable the test when it doesn't depend on PublishPipeline (via getPublishTestMessages)
    let client: StreamrClient

    beforeEach(() => {
        client = createClientFactory().createClient()
    })

    afterEach(async () => {
        await Promise.allSettled([client?.destroy()])
    })

    describe('addToStorageNode()', () => {
        it('single partition stream', async () => {
            const stream = await createTestStream(client, module, {
                partitions: 1
            })
            await expect(stream.addToStorageNode(DOCKER_DEV_STORAGE_NODE)) // resolves after assignment stream messages have arrived
                .resolves
                .toEqual(undefined)
        })

        it('multi-partition stream', async () => {
            const stream = await createTestStream(client, module, {
                partitions: 5
            })
            await expect(stream.addToStorageNode(DOCKER_DEV_STORAGE_NODE)) // resolves after assignment stream messages have arrived
                .resolves
                .toEqual(undefined)
        })

        it('assigning stream to non-existing storage node', async () => {
            const stream = await createTestStream(client, module, {
                partitions: 1
            })
            await expect(stream.addToStorageNode(DUMMY_ADDRESS))
                .rejects
                .toThrow('No storage node')
        })
    })

    describe('detectFields()', () => {
        let stream: Stream

        beforeEach(async () => {
            stream = await createTestStream(client, module)
            await stream.addToStorageNode(DOCKER_DEV_STORAGE_NODE)
        })

        it('does detect primitive types', async () => {
            const msg = {
                number: 123,
                boolean: true,
                object: {
                    k: 1,
                    v: 2,
                },
                array: [1, 2, 3],
                string: 'test',
            }
            const publishTestMessages = getPublishTestMessages(client, stream, {
                waitForLast: true,
                createMessage: () => msg,
            })
            await publishTestMessages(1)

            expect(stream.config.fields).toEqual([])
            await stream.detectFields()
            const expectedFields = [
                {
                    name: 'number',
                    type: 'number',
                },
                {
                    name: 'boolean',
                    type: 'boolean',
                },
                {
                    name: 'object',
                    type: 'map',
                },
                {
                    name: 'array',
                    type: 'list',
                },
                {
                    name: 'string',
                    type: 'string',
                },
            ]

            expect(stream.config.fields).toEqual(expectedFields)
            const loadedStream = await client.getStream(stream.id)
            expect(loadedStream.config.fields).toEqual(expectedFields)
        })

        it('skips unsupported types', async () => {
            const msg = {
                null: null,
                empty: {},
                func: () => null,
                nonexistent: undefined,
                symbol: Symbol('test'),
                // TODO: bigint: 10n,
            }
            const publishTestMessages = getPublishTestMessages(client, stream, {
                waitForLast: true,
                createMessage: () => msg,
            })
            await publishTestMessages(1)

            expect(stream.config.fields).toEqual([])
            await stream.detectFields()
            const expectedFields = [
                {
                    name: 'null',
                    type: 'map',
                },
                {
                    name: 'empty',
                    type: 'map',
                },
            ]

            expect(stream.config.fields).toEqual(expectedFields)

            const loadedStream = await client.getStream(stream.id)
            expect(loadedStream.config.fields).toEqual(expectedFields)
        })
    })
})
