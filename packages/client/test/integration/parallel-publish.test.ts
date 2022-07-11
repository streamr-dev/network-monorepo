import 'reflect-metadata'
import { DependencyContainer } from 'tsyringe'
import { random, uniq } from 'lodash'
import { fastWallet, wait } from 'streamr-test-utils'
import { StreamMessage } from 'streamr-client-protocol'
import { StreamrClient } from '../../src/StreamrClient'
import { StreamPermission } from '../../src/permission'
import { Stream } from '../../src/Stream'
import { addFakeNode, createFakeContainer, DEFAULT_CLIENT_OPTIONS } from './../test-utils/fake/fakeEnvironment'
import { GroupKeyStoreFactory } from './../../src/encryption/GroupKeyStoreFactory'
import { EncryptionUtil } from './../../src/encryption/EncryptionUtil'
import { collect } from '../../src/utils/iterators'

const MESSAGE_COUNT = 100

/*
 * Publishes message concurrently. Produces one message chain which contains messages in the correct order.
 */
describe('parallel publish', () => {

    const publisherWallet = fastWallet()
    const subscriberWallet = fastWallet()
    let publisher: StreamrClient
    let stream: Stream
    let receivedMessages: AsyncIterableIterator<StreamMessage<any>>
    let dependencyContainer: DependencyContainer

    beforeAll(async () => {
        const config = {
            ...DEFAULT_CLIENT_OPTIONS,
            auth: {
                privateKey: publisherWallet.privateKey
            }
        }
        dependencyContainer = createFakeContainer(config)
        publisher = new StreamrClient(config, dependencyContainer)
        stream = await publisher.createStream('/path')
        await stream.grantPermissions({
            user: subscriberWallet.address,
            permissions: [StreamPermission.SUBSCRIBE]
        })
        receivedMessages = addFakeNode(subscriberWallet.address, dependencyContainer).addSubscriber(...stream.getStreamParts())
    })

    it('messages in order and in same chain', async () => {
        const publishTasks = []
        for (let i = 0; i < MESSAGE_COUNT; i++) {
            const task = publisher.publish(stream.id, {
                mockId: i
            })
            publishTasks.push(task)
            if (Math.random() < 0.5) {
                await wait(random(5))
            }
        }
        await Promise.all(publishTasks)

        const sortedMessages = (await collect(receivedMessages, MESSAGE_COUNT)).sort((m1, m2) => {
            const timestampDiff = m1.getTimestamp() - m2.getTimestamp()
            return (timestampDiff !== 0) ? timestampDiff : (m1.getSequenceNumber() - m2.getSequenceNumber())
        })
        expect(uniq(sortedMessages.map((m) => m.getMsgChainId()))).toHaveLength(1)
        expect(sortedMessages[0].prevMsgRef).toBeNull()
        expect(sortedMessages.every((m, i) => {
            if (i === 0) {
                return m.prevMsgRef === null
            } else {
                const previous = sortedMessages[i - 1]
                return (m.prevMsgRef!.timestamp === previous.getTimestamp()) && (m.prevMsgRef!.sequenceNumber === previous.getSequenceNumber())
            }
        })).toBeTrue()

        const groupKeyIds = uniq(sortedMessages.map((m) => m.groupKeyId))
        expect(groupKeyIds).toHaveLength(1)

        const groupKeyStore = await dependencyContainer.resolve(GroupKeyStoreFactory).getStore(stream.id)
        const groupKey = await groupKeyStore.get(groupKeyIds[0]!)
        const decryptedMessages = sortedMessages.map((m) => {
            EncryptionUtil.decryptStreamMessage(m, groupKey!)
            return m
        })
        expect(decryptedMessages.every((m, i) => m.getParsedContent().mockId === i)).toBeTrue()
    })
})
