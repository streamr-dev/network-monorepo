import 'reflect-metadata'
import { waitForCondition } from 'streamr-test-utils'
import { StreamPartID, StreamPartIDUtils } from 'streamr-client-protocol'
import { StreamrClient } from './../../src/StreamrClient'
import { Subscription } from '../../src/subscribe/Subscription'
import { GroupKey } from '../../src/encryption/GroupKey'
import { StreamPermission } from '../../src/permission'
import { createClientFactory } from './../test-utils/fake/fakeEnvironment'
import { nextValue } from '../../src/utils/iterators'

/*
 * Subscriber has subscribed to a stream, and the publisher updates the encryption key for that stream.
 * The subscriber can get the updated key and decrypt received messages with it.
 */
describe('update encryption key', () => {

    let publisher: StreamrClient
    let subscriber: StreamrClient
    let streamPartId: StreamPartID
    let sub: Subscription

    beforeEach(async () => {
        const clientFactory = createClientFactory()
        publisher = clientFactory.createClient()
        subscriber = clientFactory.createClient()
        const stream = await publisher.createStream('/path')
        await stream.grantPermissions({
            user: await subscriber.getAddress(),
            permissions: [StreamPermission.SUBSCRIBE]
        })
        streamPartId = stream.getStreamParts()[0]
        sub = await subscriber.subscribe(streamPartId)
    })

    it('rotate', async () => {
        await publisher.publish(streamPartId, {
            mockId: 1
        })
        const msg1 = await nextValue(sub)
        expect(msg1!.getParsedContent()).toEqual({
            mockId: 1
        })

        const rotatedKey = GroupKey.generate()
        await publisher.updateEncryptionKey({
            key: rotatedKey,
            distributionMethod: 'rotate',
            streamId: StreamPartIDUtils.getStreamID(streamPartId)
        })

        await publisher.publish(streamPartId, {
            mockId: 2
        })
        const msg2 = await nextValue(sub)
        expect(msg2!.getParsedContent()).toEqual({
            mockId: 2
        })

        await publisher.publish(streamPartId, {
            mockId: 3
        })
        const msg3 = await nextValue(sub)
        expect(msg3!.getParsedContent()).toEqual({
            mockId: 3
        })
    })

    it('rekey', async () => {
        await publisher.publish(streamPartId, {
            mockId: 1
        })
        const msg1 = await nextValue(sub)
        expect(msg1!.getParsedContent()).toEqual({
            mockId: 1
        })

        const rekeyedKey = GroupKey.generate()
        await publisher.updateEncryptionKey({
            key: rekeyedKey,
            distributionMethod: 'rekey',
            streamId: StreamPartIDUtils.getStreamID(streamPartId)
        })

        await publisher.publish(streamPartId, {
            mockId: 2
        })
        const msg2 = await nextValue(sub)
        expect(msg2!.getParsedContent()).toEqual({
            mockId: 2
        })
    })

    describe('permission revoked', () => {

        it('rotate', async () => {
            await publisher.publish(streamPartId, {
                mockId: 1
            })
            const msg1 = await nextValue(sub)
            expect(msg1!.getParsedContent()).toEqual({
                mockId: 1
            })

            await publisher.revokePermissions(StreamPartIDUtils.getStreamID(streamPartId), {
                user: await subscriber.getAddress(),
                permissions: [StreamPermission.SUBSCRIBE]
            })
            const rotatedKey = GroupKey.generate()
            await publisher.updateEncryptionKey({
                key: rotatedKey,
                distributionMethod: 'rotate',
                streamId: StreamPartIDUtils.getStreamID(streamPartId)
            })

            await publisher.publish(streamPartId, {
                mockId: 2
            })
            const msg2 = await nextValue(sub)
            expect(msg2!.getParsedContent()).toEqual({
                mockId: 2
            })
        })

        it('rekey', async () => {
            await publisher.publish(streamPartId, {
                mockId: 1
            })
            const msg1 = await nextValue(sub)
            expect(msg1!.getParsedContent()).toEqual({
                mockId: 1
            })

            await publisher.revokePermissions(StreamPartIDUtils.getStreamID(streamPartId), {
                user: await subscriber.getAddress(),
                permissions: [StreamPermission.SUBSCRIBE]
            })
            await publisher.updateEncryptionKey({
                key: GroupKey.generate(),
                distributionMethod: 'rekey',
                streamId: StreamPartIDUtils.getStreamID(streamPartId)
            })

            await publisher.publish(streamPartId, {
                mockId: 2
            })
            const onError = jest.fn()
            sub.on('error', onError)
            await waitForCondition(() => onError.mock.calls.length > 0)
            expect(onError.mock.calls[0][0].message).toContain('Unable to decrypt')
        })
    })
})