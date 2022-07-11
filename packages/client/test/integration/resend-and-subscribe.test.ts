import 'reflect-metadata'
import { DependencyContainer } from 'tsyringe'
import { StreamRegistry } from '../../src/registry/StreamRegistry'
import { GroupKey } from '../../src/encryption/GroupKey'
import { createMockMessage } from '../test-utils/utils'
import { Stream } from '../../src/Stream'
import { fastWallet } from 'streamr-test-utils'
import { StreamPermission } from '../../src/permission'
import { DOCKER_DEV_STORAGE_NODE } from '../../src/ConfigTest'
import { FakeStorageNode } from '../test-utils/fake/FakeStorageNode'
import { ActiveNodes } from '../test-utils/fake/ActiveNodes'
import { StreamStorageRegistry } from '../../src/registry/StreamStorageRegistry'
import { StreamrClient } from '../../src/StreamrClient'
import { createFakeContainer, DEFAULT_CLIENT_OPTIONS } from '../test-utils/fake/fakeEnvironment'
import { addFakePublisherNode } from './../test-utils/fake/fakePublisherNode'
import { nextValue } from './../../src/utils/iterators'

/*
 * Subscriber fetches a historical message and can use the encryption key from the message
 * to decrypt a realtime message
 */
describe('resend and subscribe', () => {

    const subscriberWallet = fastWallet()
    const publisherWallet = fastWallet()
    let subscriber: StreamrClient
    let stream: Stream
    let dependencyContainer: DependencyContainer

    beforeAll(async () => {
        const config = {
            ...DEFAULT_CLIENT_OPTIONS,
            auth: {
                privateKey: subscriberWallet.privateKey
            }
        }
        dependencyContainer = createFakeContainer(config)
        const streamRegistry = dependencyContainer.resolve(StreamRegistry)
        stream = await streamRegistry.createStream('/path')
        await stream.grantPermissions({
            user: publisherWallet.address,
            permissions: [StreamPermission.PUBLISH]
        })
        const storageNodeRegistry = dependencyContainer.resolve(StreamStorageRegistry)
        storageNodeRegistry.addStreamToStorageNode(stream.id, DOCKER_DEV_STORAGE_NODE)
        subscriber = new StreamrClient(config, dependencyContainer)
    })

    it('happy path', async () => {
        const groupKey = GroupKey.generate()
        const onGroupKeyRequest = jest.fn().mockResolvedValue(undefined)
        const publisherNode = await addFakePublisherNode(publisherWallet, [groupKey], dependencyContainer, onGroupKeyRequest)

        const historicalMessage = createMockMessage({
            timestamp: 1000,
            encryptionKey: groupKey,
            stream,
            publisher: publisherWallet,
            content: {
                mockId: 1
            }
        })
        const storageNode = dependencyContainer.resolve(ActiveNodes).getNode(DOCKER_DEV_STORAGE_NODE) as FakeStorageNode
        storageNode.storeMessage(historicalMessage)

        const sub = await subscriber.subscribe({
            streamId: stream.id,
            partition: 0,
            resend: {
                last: 1
            }
        })

        const receivedMessage1 = await nextValue(sub)

        const realtimeMessage = createMockMessage({
            timestamp: 2000,
            publisher: publisherWallet,
            stream,
            encryptionKey: groupKey,
            content: {
                mockId: 2
            }
        })
        publisherNode.publishToNode(realtimeMessage)

        const receivedMessage2 = await nextValue(sub)
        expect(receivedMessage1!.getParsedContent()).toEqual({
            mockId: 1
        })
        expect(receivedMessage2!.getParsedContent()).toEqual({
            mockId: 2
        })
        expect(onGroupKeyRequest).toBeCalledTimes(1)
    })
})