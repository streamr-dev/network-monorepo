import 'reflect-metadata'
import { DependencyContainer } from 'tsyringe'
import { Wallet } from '@ethersproject/wallet'
import { Stream } from '../../src/Stream'
import { StreamRegistry } from '../../src/registry/StreamRegistry'
import { Subscriber } from '../../src/subscribe/Subscriber'
import { Subscription } from './../../src/subscribe/Subscription'
import { addFakeNode, createFakeContainer } from '../test-utils/fake/fakeEnvironment'
import { addFakePublisherNode } from '../test-utils/fake/fakePublisherNode'
import { StreamPermission } from '../../src'
import { createMockMessage } from '../test-utils/utils'
import { GroupKey } from '../../src/encryption/GroupKey'
import { collect, nextValue } from '../../src/utils/iterators'
import { fastWallet, waitForCondition } from 'streamr-test-utils'
import { StreamMessage } from 'streamr-client-protocol'
import { EncryptionUtil } from '../../src/encryption/EncryptionUtil'

const MOCK_CONTENT = { foo: 'bar' }

describe('Subscriber', () => {

    let sub: Subscription
    let stream: Stream
    let subscriberWallet: Wallet
    let publisherWallet: Wallet
    let dependencyContainer: DependencyContainer

    beforeEach(async () => {
        subscriberWallet = fastWallet()
        publisherWallet = fastWallet()
        dependencyContainer = createFakeContainer({
            auth: {
                privateKey: subscriberWallet.privateKey
            }
        })
        const streamRegistry = dependencyContainer.resolve(StreamRegistry)
        stream = await streamRegistry.createStream('/path')
        await stream.grantPermissions({
            permissions: [StreamPermission.PUBLISH],
            user: publisherWallet.address
        })
        const subscriber = dependencyContainer.resolve(Subscriber)
        sub = await subscriber.subscribe(stream.id)
    })

    it('without encryption', async () => {
        const publisherNode = addFakeNode(publisherWallet.address, dependencyContainer)
        publisherNode.publishToNode(createMockMessage({
            stream,
            publisher: publisherWallet,
            content: MOCK_CONTENT
        }))

        const receivedMessage = await nextValue(sub)
        expect(receivedMessage).toMatchObject({
            messageId: {
                msgChainId: expect.any(String),
                publisherId: expect.toEqualCaseInsensitive(publisherWallet.address),
                sequenceNumber: 0,
                streamId: stream.id,
                streamPartition: 0,
                timestamp: expect.any(Number)
            },
            prevMsgRef: null,
            messageType: StreamMessage.MESSAGE_TYPES.MESSAGE,
            encryptionType: StreamMessage.ENCRYPTION_TYPES.NONE,
            groupKeyId: null,
            newGroupKey: null,
            signature: expect.any(String),
            signatureType: StreamMessage.SIGNATURE_TYPES.ETH,
            contentType: 0,
            serializedContent: JSON.stringify(MOCK_CONTENT),
        })
        expect(receivedMessage!.getParsedContent()).toEqual(MOCK_CONTENT)
    })

    it('with encryption', async () => {
        const groupKey = GroupKey.generate()
        const nextGroupKey = GroupKey.generate()
        const publisherNode = await addFakePublisherNode(publisherWallet, [groupKey], dependencyContainer)

        publisherNode.publishToNode(createMockMessage({
            stream,
            publisher: publisherWallet,
            content: MOCK_CONTENT,
            encryptionKey: groupKey,
            newGroupKey: EncryptionUtil.encryptGroupKey(nextGroupKey, groupKey)
        }))

        const receivedMessage = await nextValue(sub)
        // TODO Currently the decryption process modifies many fields of a message. It would maybe make sense
        // if it only updated the parsedContent field, and not other fields of StreamMessage. This test
        // reflects the current behavior, and therefore Subscriber receives a message which has:
        // - encryptionType NONE insteaof of AES
        // - newGroupKey in decrypted format instead of encrypted format
        // - serializedContent decrypted
        expect(receivedMessage).toMatchObject({
            messageId: {
                msgChainId: expect.any(String),
                publisherId: expect.toEqualCaseInsensitive(publisherWallet.address),
                sequenceNumber: 0,
                streamId: stream.id,
                streamPartition: 0,
                timestamp: expect.any(Number)
            },
            prevMsgRef: null,
            messageType: StreamMessage.MESSAGE_TYPES.MESSAGE,
            encryptionType: StreamMessage.ENCRYPTION_TYPES.NONE,
            groupKeyId: groupKey.id,
            newGroupKey: nextGroupKey,
            signature: expect.any(String),
            signatureType: StreamMessage.SIGNATURE_TYPES.ETH,
            contentType: 0,
            serializedContent: JSON.stringify(MOCK_CONTENT),
        })
        expect(receivedMessage!.getParsedContent()).toEqual(MOCK_CONTENT)
    })

    it('no permission', async () => {
        await stream.revokePermissions({
            permissions: [StreamPermission.SUBSCRIBE],
            user: subscriberWallet.address
        })
        const onError = jest.fn()
        sub.on('error', onError)

        const publisherNode = addFakeNode(publisherWallet.address, dependencyContainer)
        publisherNode.publishToNode(createMockMessage({
            stream,
            publisher: publisherWallet,
            encryptionKey: GroupKey.generate()
        }))

        await waitForCondition(() => onError.mock.calls.length > 0)
        expect(onError.mock.calls[0][0].message).toInclude('not a subscriber')
    })

    it('group key response error', async () => {
        const onError = jest.fn()
        sub.on('error', onError)

        const publisherNode = await addFakePublisherNode(
            publisherWallet,
            [],
            dependencyContainer,
            async () => 'mock-error-code'
        )
        publisherNode.publishToNode(createMockMessage({
            stream,
            publisher: publisherWallet,
            content: MOCK_CONTENT,
            encryptionKey: GroupKey.generate()
        }))

        await waitForCondition(() => onError.mock.calls.length > 0)
        expect(onError.mock.calls[0][0].message).toInclude('GroupKeyErrorResponse')
    })

    it('skip invalid messages', async () => {
        const onError = jest.fn()
        sub.on('error', onError)

        const publisherNode = addFakeNode(publisherWallet.address, dependencyContainer)
        const publishedMessages = [1000, 2000, 3000].map((timestamp) => {
            return createMockMessage({
                timestamp,
                stream,
                publisher: publisherWallet
            })
        })
        publishedMessages[1].signature = 'invalid-signature'
        publishedMessages.forEach((m) => publisherNode.publishToNode(m))

        const receivedMessages = await collect(sub, 2)
        expect(receivedMessages).toHaveLength(2)
        expect(receivedMessages[0].getTimestamp()).toBe(1000)
        expect(receivedMessages[1].getTimestamp()).toBe(3000)
        expect(onError).toBeCalled()
        expect(onError.mock.calls[0][0].message).toInclude('Signature validation failed')
    })

    it('custom error handler throws', async () => {
        const onError = jest.fn().mockImplementation(() => {
            throw new Error('mock-error')
        })
        sub.on('error', onError)

        const publisherNode = addFakeNode(publisherWallet.address, dependencyContainer)
        const msg = createMockMessage({
            stream,
            publisher: publisherWallet
        })
        msg.signature = 'invalid-signature'
        publisherNode.publishToNode(msg)

        // TODO would it make sense, if we custom error handler doesn't stop the pipepline
        // and we just continue normally (could e.g. write an error to console.log)
        await expect(() => collect(sub)).rejects.toThrow('mock-error')
    })
})
