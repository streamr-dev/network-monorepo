import 'reflect-metadata'
import { createFakeContainer } from './../test-utils/fake/fakeEnvironment'
import { DEFAULT_CLIENT_OPTIONS } from '../test-utils/fake/fakeEnvironment'
import { StreamrClient } from '../../src/StreamrClient'
import { GroupKey } from '../../src/encryption/GroupKey'

describe('StreamrClient', () => {

    describe('public API', () => {

        const client = new StreamrClient({
            ...DEFAULT_CLIENT_OPTIONS
        }, createFakeContainer(undefined))

        it('updateEncryptionKey', async () => {
            await expect(() => {
                // @ts-expect-error invalid argument
                return client.updateEncryptionKey()
            }).rejects.toThrow('Cannot read properties of undefined (reading \'streamId\')') // TODO could throw better error message
            await expect(() => client.updateEncryptionKey({
                // @ts-expect-error invalid argument
                streamId: undefined,
                key: GroupKey.generate(),
                distributionMethod: 'rotate'
            })).rejects.toThrow('streamId')
        })
    })
})
