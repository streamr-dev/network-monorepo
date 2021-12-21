import { Wallet } from 'ethers'

import { clientOptions, uid, createTestStream, until, fakeAddress, createRelativeTestStreamId, getPrivateKey, fakePrivateKey } from '../utils'
import { NotFoundError } from '../../src/authFetch'
import { StreamrClient } from '../../src/StreamrClient'
import { Stream, StreamPermission } from '../../src/Stream'
import { wait } from 'streamr-test-utils'
import { storageNodeTestConfig } from './devEnvironment'

jest.setTimeout(40000)

/**
 * These tests should be run in sequential order!
 */
function TestStreamEndpoints(getName: () => string, delay: number) {
    let client: StreamrClient
    let wallet: Wallet
    let createdStream: Stream
    let otherWallet: Wallet
    let storageNodeAddress: string

    beforeAll(async () => {
        await wait(delay)
        wallet = new Wallet(await getPrivateKey())
        otherWallet = new Wallet(await getPrivateKey())
        client = new StreamrClient({
            ...clientOptions,
            auth: {
                privateKey: wallet.privateKey,
            },
        })
    })

    beforeAll(async () => {
        createdStream = await createTestStream(client, module, {
            name: getName(),
            requireSignedData: true,
            requireEncryptedData: false,
        })
        const storageNodeWallet = new Wallet(storageNodeTestConfig.privatekey)
        // const storageNodeClient = new StreamrClient({
        //     ...clientOptions,
        //     auth: {
        //         privateKey: storageNodeWallet.privateKey,
        //     },
        // })
        // await storageNodeClient.setNode(storageNodeTestConfig.url)
        storageNodeAddress = storageNodeWallet.address
        // storageNode = await client.getStorageNode(await storageNodeWallet.getAddress())
    })

    describe('createStream', () => {
        it('creates a stream with correct values', async () => {
            const name = getName()
            const id = await createRelativeTestStreamId(module)
            const stream = await client.createStream({
                id,
                name,
                requireSignedData: true,
                requireEncryptedData: true,
            })
            await until(async () => { return client.streamExistsOnTheGraph(stream.streamId) }, 100000, 1000)
            expect(stream.id).toBeTruthy()
            return expect(stream.name).toBe(name)
        })

        it('valid id', async () => {
            const newId = `${wallet.address.toLowerCase()}/StreamEndpoints-createStream-newId-${Date.now()}`
            const newStream = await client.createStream({
                id: newId,
            })
            await until(async () => { return client.streamExistsOnTheGraph(newId) }, 100000, 1000)
            expect(newStream.id).toEqual(newId)
        })

        it('valid path', async () => {
            const newPath = `/StreamEndpoints-createStream-newPath-${Date.now()}`
            const expectedId = `${wallet.address.toLowerCase()}${newPath}`
            const newStream = await client.createStream({
                id: newPath,
            })
            await until(async () => { return client.streamExistsOnTheGraph(expectedId) }, 100000, 1000)
            expect(newStream.id).toEqual(expectedId)
        })

        it('invalid id', async () => {
            await expect(async () => client.createStream({ id: 'invalid.eth/foobar' })).rejects.toThrow()
        })
    })

    describe('getStream', () => {
        it('get an existing Stream', async () => {
            const stream = await createTestStream(client, module)
            const existingStream = await client.getStream(stream.id)
            expect(existingStream.id).toEqual(stream.id)
        })

        it('get a non-existing Stream', async () => {
            const streamid = `${wallet.address.toLowerCase()}/StreamEndpoints-nonexisting-${Date.now()}`
            return expect(() => client.getStream(streamid)).rejects.toThrow(NotFoundError)
        })

        it('get all Streams', async () => {
            const streams = await client.getAllStreams()
            const streamsPagesize2 = await client.getAllStreams(1)
            expect(streams).toEqual(streamsPagesize2)
        })
    })

    describe('getStreamByName', () => {
        it('get an existing Stream', async () => {
            const name = 'name-' + Date.now()
            const props = { id: await createRelativeTestStreamId(module), name }
            const stream = await client.createStream(props)
            await until(async () => { return client.streamExistsOnTheGraph(stream.id) }, 100000, 1000)
            // await new Promise((resolve) => setTimeout(resolve, 5000))
            const existingStream = await client.getStreamByName(stream.name)
            expect(existingStream.id).toEqual(stream.id)
        })

        it('get a non-existing Stream', async () => {
            const name = `${wallet.address.toLowerCase()}/StreamEndpoints-nonexisting-${Date.now()}`
            return expect(() => client.getStreamByName(name)).rejects.toThrow(NotFoundError)
        })
    })

    describe('liststreams with search and filters', () => {
        it('get streamlist', async () => {
            // create n streams to test offset and max
            const name = 'filter-' + Date.now()
            for (let i = 0; i < 3; i++) {
                // eslint-disable-next-line no-await-in-loop
                const props = { id: await createRelativeTestStreamId(module), name }
                props.name = name + i
                // eslint-disable-next-line no-await-in-loop
                await client.createStream(props)
            }
            await until(async () => { return (await client.listStreams({ name })).length === 3 }, 20000, 1000)
            let resultList = await client.listStreams({
                name
            })
            expect(resultList.length).toBe(3)
            resultList = await client.listStreams({
                name,
                max: 2,
            })
            expect(resultList.length).toBe(2)
            expect(resultList[0].name.endsWith('0')).toBe(true)
            expect(resultList[1].name.endsWith('1')).toBe(true)
            resultList = await client.listStreams({
                name,
                max: 2,
                offset: 1
            })
            expect(resultList[0].name.endsWith('1')).toBe(true)
            return expect(resultList[1].name.endsWith('2')).toBe(true)
        })

        it('get a non-existing Stream', async () => {
            const name = `${wallet.address.toLowerCase()}/StreamEndpoints-nonexisting-${Date.now()}`
            return expect(() => client.getStreamByName(name)).rejects.toThrow()
        })
    })

    describe('getOrCreate', () => {
        it('existing Stream by name', async () => {
            const existingStream = await client.getOrCreateStream({
                name: createdStream.name,
            })
            expect(existingStream.id).toBe(createdStream.id)
            return expect(existingStream.name).toBe(createdStream.name)
        })

        it('existing Stream by id', async () => {
            const existingStream = await client.getOrCreateStream({
                id: createdStream.id,
            })
            expect(existingStream.id).toBe(createdStream.id)
            return expect(existingStream.name).toBe(createdStream.name)
        })

        it('new Stream by name', async () => {
            const newName = uid('stream')
            const props = { id: await createRelativeTestStreamId(module), name: '' }
            props.name = newName
            const newStream = await client.getOrCreateStream(props)
            return expect(newStream.name).toEqual(newName)
        })

        it('new Stream by id', async () => {
            const newId = `${wallet.address.toLowerCase()}/StreamEndpoints-getOrCreate-newId-${Date.now()}`
            const newStream = await client.getOrCreateStream({
                id: newId,
            })
            return expect(newStream.id).toEqual(newId)
        })

        it('new Stream by path', async () => {
            const newPath = `/StreamEndpoints-getOrCreate-newPath-${Date.now()}`
            const newStream = await client.getOrCreateStream({
                id: newPath,
            })
            expect(newStream.id).toEqual(`${wallet.address.toLowerCase()}${newPath}`)

            // ensure can get after create i.e. doesn't try create again
            const sameStream = await client.getOrCreateStream({
                id: newPath,
            })
            expect(sameStream.id).toEqual(newStream.id)
        })

        it('fails if stream prefixed with other users address', async () => {
            // can't create streams for other users
            const otherAddress = `0x${fakeAddress()}`
            const newPath = `/StreamEndpoints-getOrCreate-newPath-${Date.now()}`
            // backend should error
            await expect(async () => {
                await client.getOrCreateStream({
                    id: `${otherAddress}${newPath}`,
                })
            }).rejects.toThrow('Validation')
        })
    })

    describe('listStreams', () => {
        it('filters by given criteria (match)', async () => {
            const result = await client.listStreams({
                name: createdStream.name,
            })
            expect(result.length).toBe(1)
            return expect(result[0].id).toBe(createdStream.id)
        })

        it('filters by given criteria (no  match)', async () => {
            const result = await client.listStreams({
                name: `non-existent-${Date.now()}`,
            })
            return expect(result.length).toBe(0)
        })
    })

    describe('getStreamLast', () => {
        it('does error if has no storage assigned', async () => {
            await expect(async () => {
                await client.getStreamLast(createdStream.id)
            }).rejects.toThrow()
        })

        it('does not error if has storage assigned', async () => {
            const stream = await client.createStream({
                id: await createRelativeTestStreamId(module),
            })
            await stream.addToStorageNode(storageNodeAddress)
            await until(async () => { return client.isStreamStoredInStorageNode(stream.id, storageNodeAddress) }, 100000, 1000)
            const result = await client.getStreamLast(stream.id)
            expect(result).toEqual([])
        })
    })

    describe('getStreamPublishers', () => {
        it('retrieves a list of publishers', async () => {
            const publishers = await client.getStreamPublishers(createdStream.id)
            const address = await client.getAddress()
            return expect(publishers).toEqual([address])
        })
        it('retrieves a list of publishers, pagination', async () => {
            await createdStream.grantUserPermission(StreamPermission.PUBLISH, fakeAddress())
            await createdStream.grantUserPermission(StreamPermission.PUBLISH, fakeAddress())
            const allPublishers = await client.getStreamPublishers(createdStream.id, 1000)
            const pagedPublishers = await client.getStreamPublishers(createdStream.id, 2)
            return expect(pagedPublishers).toEqual(allPublishers)
        })
    })

    describe('isStreamPublisher', () => {
        it('returns true for valid publishers', async () => {
            const address = await client.getAddress()
            const valid = await client.isStreamPublisher(createdStream.id, address)
            return expect(valid).toBeTruthy()
        })
        it('returns trow error for invalid udseraddress', async () => {
            return expect(() => client.isStreamPublisher(createdStream.id, 'some-invalid-address')).rejects.toThrow()
        })
        it('returns false for invalid publishers', async () => {
            const valid = await client.isStreamPublisher(createdStream.id, fakeAddress())
            return expect(!valid).toBeTruthy()
        })
    })

    describe('getStreamSubscribers', () => {
        it('retrieves a list of subscribers', async () => {
            const subscribers = await client.getStreamSubscribers(createdStream.id)
            const address = await client.getAddress()
            return expect(subscribers).toEqual([address])
        })
        it('retrieves a list of subscribers, pagination', async () => {
            await createdStream.grantUserPermission(StreamPermission.SUBSCRIBE, fakeAddress())
            await createdStream.grantUserPermission(StreamPermission.SUBSCRIBE, fakeAddress())
            const allSubscribers = await client.getStreamPublishers(createdStream.id, 1000)
            const pagedSubscribers = await client.getStreamPublishers(createdStream.id, 2)
            return expect(pagedSubscribers).toEqual(allSubscribers)
        })
    })

    describe('isStreamSubscriber', () => {
        it('returns true for valid subscribers', async () => {
            const address = await client.getAddress()
            const valid = await client.isStreamSubscriber(createdStream.id, address)
            return expect(valid).toBeTruthy()
        })
        it('returns trow error for invalid udseraddress', async () => {
            return expect(() => client.isStreamSubscriber(createdStream.id, 'some-invalid-address')).rejects.toThrow()
        })
        it('returns false for invalid subscribers', async () => {
            const valid = await client.isStreamSubscriber(createdStream.id, fakeAddress())
            return expect(!valid).toBeTruthy()
        })
    })

    describe('Stream.update', () => {
        it('can change stream name', async () => {
            createdStream.name = 'Newname'
            await createdStream.update()
            await until(async () => {
                try {
                    return (await client.getStream(createdStream.id)).name === createdStream.name
                } catch (err) {
                    return false
                }
            }, 100000, 1000)
            const stream = await client.getStream(createdStream.id)
            return expect(stream.name).toEqual(createdStream.name)
        })
    })

    describe('Stream permissions', () => {
        const INVALID_USER_IDS = [
            '',
            0,
            1,
            /regex/,
            {},
            false,
            true,
            Symbol('test'),
            function test() {},
            new Date(0),
            Infinity,
            Number.NaN,
            new Error('invalid')
            // null, undefined are the public user.
        ]

        it('Stream.getPermissions', async () => {
            const permissions = await createdStream.getPermissions()
            return expect(permissions.length).toBeGreaterThan(0)
        })

        describe('Stream.hasPermission', () => {
            it('gets permission', async () => {
                expect(await createdStream.hasUserPermission(StreamPermission.GRANT, wallet.address)).toBeTruthy()
                expect(await createdStream.hasUserPermission(StreamPermission.GRANT, otherWallet.address)).not.toBeTruthy()
            })

            it('errors if invalid userId', async () => {
                for (const invalidId of INVALID_USER_IDS) {
                    // eslint-disable-next-line no-await-in-loop, no-loop-func
                    await expect(async () => {
                        // @ts-expect-error should require userId, this is part of the test
                        await createdStream.hasUserPermission(StreamPermission.GRANT, invalidId)
                    }).rejects.toThrow()
                }
            })
        })

        describe('Stream.grantPermission', () => {
            it('creates public permissions when passed undefined', async () => {
                await createdStream.grantPublicPermission(StreamPermission.SUBSCRIBE) // public read
                expect(await createdStream.hasPublicPermission(StreamPermission.SUBSCRIBE)).toBeTruthy()
            })

            it('creates user permissions when passed user id', async () => {
                await createdStream.grantUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address) // user read
                expect(await createdStream.hasUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address)).toBeTruthy()
            })

            it('sets Permissions for multiple users in one transaction', async () => {
                const userA = fakeAddress()
                const userB = fakeAddress()
                const permissionA = {
                    canEdit: true,
                    canDelete: true,
                    canPublish: true,
                    canSubscribe: true,
                    canGrant: true
                }
                const permissionB = {
                    canEdit: false,
                    canDelete: false,
                    canSubscribe: false,
                    canPublish: false,
                    canGrant: false
                }

                await createdStream.setPermissions([userA, userB], [permissionA, permissionB]) // user read
                expect(await createdStream.hasUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address)).toBeTruthy()
            })

            // it('does not error if creating multiple permissions in parallel', async () => {
            //     await Promise.all([
            //         createdStream.grantUserPermission(StreamPermission.SHARE, otherWallet.address),
            //     ])
            //     expect(await createdStream.hasUserPermission(StreamPermission.SHARE, otherWallet.address)).toBeTruthy()
            // })

            // it('does not error or create duplicates if creating multiple identical permissions in parallel', async () => {
            //     await createdStream.revokeAllUserPermissions(otherWallet.address)
            //     await Promise.all([
            //         createdStream.grantUserPermission(StreamPermission.PUBLISH, otherWallet.address),
            //         createdStream.grantUserPermission(StreamPermission.PUBLISH, otherWallet.address),
            //         createdStream.grantUserPermission(StreamPermission.PUBLISH, otherWallet.address),
            //         createdStream.grantUserPermission(StreamPermission.PUBLISH, otherWallet.address),
            //     ])
            //     expect(await createdStream.hasUserPermission(StreamPermission.PUBLISH, otherWallet.address)).toBeTruthy()
            //     expect(await createdStream.getUserPermissions(otherWallet.address)).toHaveLength(1)
            // })

            it('does not grant multiple permissions for same permission + user', async () => {
                await createdStream.grantPublicPermission(StreamPermission.SUBSCRIBE) // public read
                const previousPermissions = await createdStream.getPermissions()
                await createdStream.grantPublicPermission(StreamPermission.SUBSCRIBE) // public read
                const permissions = await createdStream.getPermissions()
                expect(permissions).toHaveLength(previousPermissions.length)
                expect(permissions).toEqual(previousPermissions)
            })

            it('errors if invalid userId', async () => {
                for (const invalidId of INVALID_USER_IDS) {
                    // eslint-disable-next-line no-await-in-loop, no-loop-func
                    await expect(async () => {
                        // @ts-expect-error should require userId, this is part of the test
                        await createdStream.grantUserPermission(StreamPermission.GRANT, invalidId)
                    }).rejects.toThrow()
                }
            })
        })

        describe('Stream.revokePermission', () => {
        //     it('removes permission by id', async () => {
        //         const publicRead = await createdStream.hasPublicPermission(StreamPermission.SUBSCRIBE)
        //         await createdStream.revokeUserPermission(publicRead!.id)
        //         expect(await createdStream.hasPublicPermission(StreamPermission.SUBSCRIBE)).not.toBeTruthy()
        //     })

            it('does not error if not found', async () => {
                await createdStream.grantPublicPermission(StreamPermission.SUBSCRIBE) // public read
                await createdStream.hasPublicPermission(StreamPermission.SUBSCRIBE)
                await createdStream.revokePublicPermission(StreamPermission.SUBSCRIBE)
                expect(await createdStream.hasPublicPermission(StreamPermission.SUBSCRIBE)).not.toBeTruthy()
            })

            it('errors if invalid permission id', async () => {
                const INVALID_PERMISSION_IDS = [
                    '',
                    -1,
                    1.5,
                    /regex/,
                    {},
                    false,
                    true,
                    Symbol('test'),
                    function test() {},
                    new Date(0),
                    Infinity,
                    -Infinity,
                    Number.NaN,
                    new Error('invalid')
                ]

                for (const invalidId of INVALID_PERMISSION_IDS) {
                    // eslint-disable-next-line no-await-in-loop, no-loop-func
                    await expect(async () => {
                        // @ts-expect-error should require valid id, this is part of the test
                        await createdStream.revokeUserPermission(invalidId)
                    }).rejects.toThrow()
                }
            })
        })

        // describe('Stream.revokePublicPermission', () => {
        //     it('removes permission', async () => {
        //         await createdStream.grantUserPermission(StreamPermission.SUBSCRIBE)
        //         await createdStream.revokePublicPermission(StreamPermission.SUBSCRIBE)
        //         expect(await createdStream.hasPublicPermission(StreamPermission.SUBSCRIBE)).not.toBeTruthy()
        //     })
        // })

        describe('Stream.revokeUserPermission', () => {
            it('removes permission', async () => {
                await createdStream.grantUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address)
                await createdStream.revokeUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address)
                expect(await createdStream.hasPublicPermission(StreamPermission.SUBSCRIBE)).not.toBeTruthy()
            })

            it('fails if no user id provided', async () => {
                await expect(async () => {
                    // @ts-expect-error should require userId, this is part of the test
                    await createdStream.revokeUserPermission(StreamPermission.SUBSCRIBE, undefined)
                }).rejects.toThrow()
            })
        })

        describe('Stream.grantUserPermission', () => {
            it('creates permission for user', async () => {
                await createdStream.revokeUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address)
                await createdStream.grantUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address) // public read
                expect(await createdStream.hasUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address)).toBeTruthy()
            })

            it('fails if no user id provided', async () => {
                await expect(async () => {
                    // @ts-expect-error should require userId, this is part of the test
                    await createdStream.grantUserPermission(StreamPermission.SUBSCRIBE, undefined)
                }).rejects.toThrow()
            })
        })

        describe('Stream.{grant,revoke,has}UserPermissions', () => {
            // it('creates & revokes permissions for user', async () => {
            //     await createdStream.revokeAllUserPermissions(otherWallet.address)
            //     expect(
            //         await createdStream.hasUserPermissions([StreamPermission.SUBSCRIBE, StreamPermission.GET], otherWallet.address)
            //     ).not.toBeTruthy()

            //     await createdStream.grantUserPermissions([StreamPermission.GET, StreamPermission.SUBSCRIBE], otherWallet.address)

            //     expect(
            //         await createdStream.hasUserPermissions([StreamPermission.SUBSCRIBE, StreamPermission.GET], otherWallet.address)
            //     ).toBeTruthy()

            //     // revoke permissions we just created
            //     await createdStream.revokeUserPermissions([StreamPermission.GET, StreamPermission.SUBSCRIBE], otherWallet.address)

            //     expect(
            //         await createdStream.hasUserPermissions([StreamPermission.SUBSCRIBE, StreamPermission.GET], otherWallet.address)
            //     ).not.toBeTruthy()
            // })

            it('fails if no user id provided', async () => {
                await expect(async () => {
                    // @ts-expect-error should require userId, this is part of the test
                    await createdStream.revokeUserPermissions([StreamPermission.SUBSCRIBE], undefined)
                }).rejects.toThrow()
            })
        })

        describe('Stream.revokeAllUserPermissions', () => {
            it('revokes all user permissions', async () => {
                await createdStream.grantUserPermission(StreamPermission.SUBSCRIBE, otherWallet.address)
                expect((await createdStream.getUserPermissions(otherWallet.address)).canSubscribe).toBe(true)
                await createdStream.revokeAllUserPermissions(otherWallet.address)
                expect(await createdStream.getUserPermissions(otherWallet.address)).toEqual(
                    {
                        canDelete: false,
                        canEdit: false,
                        canPublish: false,
                        canGrant: false,
                        canSubscribe: false
                    }
                )
            })

            it('does not fail if called twice', async () => {
                await createdStream.revokeAllUserPermissions(otherWallet.address)
                await createdStream.revokeAllUserPermissions(otherWallet.address)
            })

            it('fails if no user id provided', async () => {
                await expect(async () => {
                    // @ts-expect-error should require userId, this is part of the test
                    await createdStream.revokeAllUserPermissions(undefined)
                }).rejects.toThrow()
            })
        })

        describe('Stream.revokeAllPublicPermissions', () => {
            it('revokes all public permissions', async () => {
                await createdStream.grantPublicPermission(StreamPermission.SUBSCRIBE)
                expect((await createdStream.getPublicPermissions()).canSubscribe).toBe(true)
                await createdStream.revokeAllPublicPermissions()
                expect(await createdStream.getPublicPermissions()).toEqual(
                    {
                        canDelete: false,
                        canEdit: false,
                        canPublish: false,
                        canGrant: false,
                        canSubscribe: false
                    }
                )
            })

            it('does not fail if called twice', async () => {
                await createdStream.getPublicPermissions()
                await createdStream.getPublicPermissions()
            })
        })
    })

    describe('Stream deletion', () => {
        it('Stream.delete', async () => {
            const props = { id: await createRelativeTestStreamId(module), name: '' }
            const stream = await client.createStream(props)
            await until(() => client.streamExistsOnTheGraph(stream.id), 100000, 1000)
            await stream.delete()
            await until(async () => {
                try {
                    await client.getStream(stream.id)
                    return false
                } catch (err: any) {
                    return err.errorCode === 'NOT_FOUND'
                }
            }, 100000, 1000)
            expect(await client.streamExists(stream.id)).toEqual(false)
            return expect(client.getStream(stream.id)).rejects.toThrow()
        })

        // it('does not throw if already deleted', async () => {
        //     await createdStream.delete()
        //     await createdStream.delete()
        // })
    })

    describe('Storage node assignment', () => {
        it('add', async () => {
            // await stream.addToStorageNode(node.getAddress())// use actual storage nodes Address, actually register it
            const stream = await createTestStream(client, module)
            await stream.addToStorageNode(storageNodeAddress)
            await until(async () => { return client.isStreamStoredInStorageNode(stream.id, storageNodeAddress) }, 100000, 1000)
            const storageNodes = await stream.getStorageNodes()
            expect(storageNodes.length).toBe(1)
            expect(storageNodes[0]).toStrictEqual(storageNodeAddress.toLowerCase())
            const storedStreamParts = await client.getStreamPartsByStorageNode(storageNodeAddress)
            return expect(storedStreamParts.some(
                (sp) => (sp.streamId === stream.id) && (sp.streamPartition === 0)
            )).toBeTruthy()
        })

        it('remove', async () => {
            const stream = await createTestStream(client, module)
            await stream.addToStorageNode(storageNodeAddress)
            await until(async () => { return client.isStreamStoredInStorageNode(stream.id, storageNodeAddress) }, 100000, 1000)
            await stream.removeFromStorageNode(storageNodeAddress)
            await until(async () => { return !(await client.isStreamStoredInStorageNode(stream.id, storageNodeAddress)) }, 100000, 1000)
            const storageNodes = await stream.getStorageNodes()
            expect(storageNodes).toHaveLength(0)
            const storedStreamParts = await client.getStreamPartsByStorageNode(storageNodeAddress)
            return expect(storedStreamParts.some(
                (sp) => (sp.streamId === stream.id)
            )).toBeFalsy()
        })
    })
}

/*TODO revert describe('StreamEndpoints', () => {
    // describe('using normal name', () => {
    //     TestStreamEndpoints(() => uid('test-stream'), 0)
    // })

    describe('using name with slashes', () => {
        TestStreamEndpoints(() => uid('test-stream/slashes'), 4000)
    })
})*/

describe('From Core-API', () => {  // TODO there is no need to have Core-API tests separately -> move to be inside TestStreamEndpoints (and remove possible duplicates)
    const ZERO_ADDRESS= '0x0000000000000000000000000000000000000000'
	const ENS_DOMAIN_OWNER =new Wallet('0xe5af7834455b7239881b85be89d905d6881dcb4751063897f12be1b0dd546bdb')  // owns testdomain1.eth ENS domain in dev mainchain

    let streamId: string
    let streamOwner: Wallet
    let streamOwnerClient: StreamrClient
    let anonymousUser: Wallet = new Wallet(fakePrivateKey())

    const getEndsOwnerClient = () => {  // TODO inline
        return new StreamrClient({
            ...clientOptions,
            auth: {
                privateKey: ENS_DOMAIN_OWNER.privateKey
            },
        })
    }

    
    const getAnonymousClient = () => {  // TODO inline
        return new StreamrClient({
            ...clientOptions
        })
    }

    beforeAll(async () => {
        streamOwner = new Wallet(await getPrivateKey())
        streamOwnerClient = new StreamrClient({
            ...clientOptions,
            auth: {
                privateKey: streamOwner.privateKey
            },
        })
        const response = await streamOwnerClient.createStream({
            id: '/default/stream/for/testing',
            name: 'Stream name with date: ' + Date.now(),
        })
        streamId = response.id
    })

    describe('POST /api/v1/streams', function () {

        it('happy path', async () => {
            const assertValidResponse = (json: any, properties: any, expectedId: string) => {
                expect(json.name).toBe(properties.name)
                expect(json.description).toBe(properties.description)
                expect(json.config).toEqual(properties.config)
                expect(json.partitions).toBe(properties.partitions)
                expect(json.autoConfigure).toBe(properties.autoConfigure)
                expect(json.storageDays).toBe(properties.storageDays)
                expect(json.inactivityThresholdHours).toBe(properties.inactivityThresholdHours)
                expect(json.id).toBe(expectedId)
            }
            const properties = {
                id: '/hello/world/stream',
                name: 'Mock name',
                description: 'Mock description',
                config: {
                    fields: [
                        {
                            name: 'mock-field',
                            type: <const>'string',
                        },
                    ],
                },
                partitions: 12,
                autoConfigure: false,
                storageDays: 66,
                inactivityThresholdHours: 4,
                uiChannel: false,
            }
            const createResponse = await streamOwnerClient.createStream(properties)
            assertValidResponse(createResponse, properties, streamOwner.address.toLowerCase() + "/hello/world/stream")
            const streamId = createResponse.id
            const fetchResponse = await streamOwnerClient.getStream(streamId)
            assertValidResponse(fetchResponse, properties, streamId)
        })

        it('missing id', () => {
            expect(async () => {
                await streamOwnerClient.createStream({
                    id: undefined,
                } as any)
            }).toThrow('Some validation message')  // FAIL: creates a stream, e.g. '0x5a35065336f969cd507bd64f58e27a6e5b6f2df5/'
        })

        it('invalid properties', () => {
            expect(async () => {
                await streamOwnerClient.createStream({
                    id: `/${Date.now()}`,
                    partitions: 999,
                })
            }).toThrow('Validation error: invalid partitions')  // FAIL
        })

        it('create with owned domain id', async () => {
            const streamId = 'testdomain1.eth/foo/bar' + Date.now()
            const properties = {
                id: streamId,
            }
            const createdStream = await getEndsOwnerClient().createStream(properties)
            expect(createdStream.id).toBe(streamId)  // FAIL
        })

        it('create with integration key id', async () => {
            const streamId = streamOwner.address + '/foo/bar' + Date.now()
            const properties = {
                id: streamId,
            }
            const createdStream = await streamOwnerClient.createStream(properties)
            expect(createdStream.id).toBe(streamId)  // FAIL: should it create the stream with exact same casing or lowercasing? or fail as it currently does?
        })

        it('create with invalid id', () => {
            expect(async () => {
                const streamId = 'foobar.eth/loremipsum'
                const properties = {
                    id: streamId,
                }
                await streamOwnerClient.createStream(properties)
            }).toThrow(`Validation error: invalid id "${streamId}"`) // FAIL: doesn't catch the contract error?
        })

        it('create stream with duplicate id', async () => {
            const now = Date.now()
            const streamId = 'testdomain1.eth/foobar/test/' + now
            const properties = {
                id: streamId,
                name: 'Hello world!',
            }
            const createdStream = await getEndsOwnerClient().createStream(properties)
            expect(createdStream.id).toBe(streamId)
            expect(async () => {
                await getEndsOwnerClient().createStream(properties)
            }).toThrow(`Stream with id ${streamId} already exists`) // FAIL: NET-608
        })

        it('create stream with too long id', async () => {
            let streamId = 'testdomain1.eth/foobar/' + Date.now() + '/'
            while (streamId.length < 256) {
                streamId = streamId + 'x'
            }
            const properties = {
                id: streamId,
            }
            expect(async () => {
                await getEndsOwnerClient().createStream(properties)
            }).toThrow(`Validation error: invalid id "${streamId}"`)  // FAIL
        })

        /*
        Maybe not applicable anymore?
        it('create stream with too long description', async () => {
            let streamId = 'testdomain1.eth/foobar/' + Date.now()
            const description = 'x'.repeat(256)
            const properties = {
                id: streamId,
                description
            }
            const response = getEndsOwnerClient().createStream(properties)
            await assertStreamrClientResponseError(response, 422, 'VALIDATION_ERROR', `Invalid description: ${description}`)
        })*/

        /*
        Maybe not applicable anymore?
        it('create stream with too long name', async () => {
            let streamId = 'testdomain1.eth/foobar/' + Date.now()
            const name = 'x'.repeat(256)
            const properties = {
                id: streamId,
                name
            }
            const response = getEndsOwnerClient().createStream(properties)
            await assertStreamrClientResponseError(response, 422, 'VALIDATION_ERROR', `Invalid name: ${name}`)
        })*/
    })

    /*
    Not applicable anymore
    describe('GET /api/v1/streams', () => {
        it('finds stream by permission name in uppercase/lowercase', async () => {
            const queryParams = {
                operation: 'stream_DELETE',
                noConfig: true,
                grantedAccess: true,
            }
            const response = await Streamr.api.v1.streams
                .list(queryParams)
                .withAuthenticatedUser(streamOwner)
                .call()
            const json = await response.json()
            assert.equal(response.status, 200)
            const result = json.filter((stream: any) => stream.id == streamId)
            assert.equal(result.length, 1, 'response should contain a single stream')
        })
    })*/

    /*
    Not applicable anymore
    describe('GET /api/v1/streams/:id', () => {
        it('works with uri-encoded ids', async () => {
            const id = streamOwner.address + '/streams-api.test.js/stream-' + Date.now()
            await streamOwnerClient.createStream({
                id,
            })
            const json = await streamOwnerClient.getStream(id)
            assert.equal(json.id, id)
        })
    })*/

    describe('GET /api/v1/streams/:id/permissions/me', () => {
        /*
        Not applicable anymore
        it('responds with status 404 when authenticated but stream does not exist', async () => {
            const response = await Streamr.api.v1.streams.permissions
                .getOwnPermissions('non-existing-stream-id')
                .withAuthenticatedUser(streamOwner)
                .call()
            assert.equal(response.status, 404)
        })*/
        it('succeeds with authentication', async () => {
            const stream = await streamOwnerClient.getOrCreateStream({
                id: streamId
            })
            expect(async () => {
                await stream.getMyPermissions()
            }).not.toThrow()
        })
        it('succeeds with no authentication', async () => {
            const stream = await getAnonymousClient().getOrCreateStream({
                id: streamId
            })
            expect(async () => {
                await stream.getMyPermissions()
            }).not.toThrow()
        })

        /*
        Not applicable anymore
        it('responds with status 401 when wrong token even if endpoint does not require authentication', async () => {
            const sessionToken = 'wrong-token'
            const response = await Streamr.api.v1.streams.permissions
                .getOwnPermissions(streamId)
                .withHeader('Authorization', `Bearer ${sessionToken}`)
                .call()
            assert.equal(response.status, 401)
        })
        it('responds with status 401 when wrong session token even if endpoint does not require authentication', async () => {
            const bearer = 'wrong-session-token'
            const response = await Streamr.api.v1.streams.permissions
                .getOwnPermissions(streamId)
                .withHeader('Authorization', `Bearer ${bearer}`)
                .call()
            assert.equal(response.status, 401)
        })*/
    })

    describe('GET /api/v1/streams/:id/validation', () => {
        it('does not require authentication', async () => {
            expect(async () => {
                await getAnonymousClient().getStreamValidationInfo(streamId) // FAIL because the info is read from Core-API
            }).not.toThrow()
        })
    })

    describe('GET /api/v1/streams/:id/publishers', () => {
        it('does not require authentication', async () => {
            expect(async () => {
                await getAnonymousClient().getStreamPublishers(streamId)
            }).not.toThrow()
        })
    })

    describe('GET /api/v1/streams/:id/publisher/0x0000000000000000000000000000000000000000', () => {
        it('should return 200 if the stream has public publish permission', async () => {
            const stream = await streamOwnerClient.createStream({
                id: `/test-stream/${Date.now()}`,
                name: 'Stream with public publish permission',
            })
            await stream.grantPublicPermission(StreamPermission.PUBLISH)
            expect(await getAnonymousClient().isStreamPublisher(stream.id, ZERO_ADDRESS)).toBe(true)
        })
        it('should return 404 if the stream does not have public publish permission', async () => {
            const stream = await streamOwnerClient.createStream({
                id: `/test-stream/${Date.now()}`,
                name: 'Stream without public publish permission',
            })
            expect(await getAnonymousClient().isStreamPublisher(stream.id, ZERO_ADDRESS)).toBe(false)
        })
    })

    describe('GET /api/v1/streams/:id/subscribers', () => {
        it('does not require authentication', async () => {
            expect(async () => {
                await getAnonymousClient().getStreamSubscribers(streamId)
            }).not.toThrow()
        })
    })

    describe('GET /api/v1/streams/:id/subscriber/0x0000000000000000000000000000000000000000', () => {
        it('should return 200 if the stream has public subscribe permission', async () => {
            const stream = await streamOwnerClient.createStream({
                id: `/test-stream/${Date.now()}`,
                name: 'Stream with public subscribe permission',
            })
            await stream.grantPublicPermission(StreamPermission.SUBSCRIBE)
            expect(await getAnonymousClient().isStreamPublisher(stream.id, ZERO_ADDRESS)).toBe(true)
        })
        it('should return 404 if the stream does not have public subscribe permission', async () => {
            const stream = await streamOwnerClient.createStream({
                id: `/test-stream/${Date.now()}`,
                name: 'Stream without public subscribe permission',
            })
            expect(await getAnonymousClient().isStreamPublisher(stream.id, ZERO_ADDRESS)).toBe(false)
        })
    })

    /* FAIL TODO are there methods to manipulate fields in StreamrClient
    describe('POST /api/v1/streams/:id/fields', () => {
        it('requires authentication', async () => {
            const response = await Streamr.api.v1.streams
                .setFields(streamId, [
                    {
                        name: 'text',
                        type: 'string',
                    },
                    {
                        name: 'user',
                        type: 'map',
                    },
                ])
                .call()

            await assertResponseIsError(response, 401, 'NOT_AUTHENTICATED')
        })

        it('validates existence of Stream', async () => {
            const response = await Streamr.api.v1.streams
                .setFields('non-existing-stream', [
                    {
                        name: 'text',
                        type: 'string',
                    },
                    {
                        name: 'user',
                        type: 'map',
                    },
                ])
                .withAuthenticatedUser(streamOwner)
                .call()

            await assertResponseIsError(response, 404, 'NOT_FOUND')
        })

        it('requires stream_edit permission on Stream', async () => {
            const response = await Streamr.api.v1.streams
                .setFields(streamId, [
                    {
                        name: 'text',
                        type: 'string',
                    },
                    {
                        name: 'user',
                        type: 'map',
                    },
                ])
                .withAuthenticatedUser(anonymousUser)
                .call()

            await assertResponseIsError(response, 403, 'FORBIDDEN', 'stream_edit')
        })

        context('when called with valid body and permissions', () => {
            let response: Response

            before(async () => {
                response = await Streamr.api.v1.streams
                    .setFields(streamId, [
                        {
                            name: 'text',
                            type: 'string',
                        },
                        {
                            name: 'user',
                            type: 'map',
                        },
                    ])
                    .withAuthenticatedUser(streamOwner)
                    .call()
            })

            it('responds with 200', () => {
                //assert.equal(response.status, 200)
            })

            it('updates stream config fields', async () => {
                const json = await response.json()
                assert.deepEqual(json.config.fields, [
                    {
                        name: 'text',
                        type: 'string',
                    },
                    {
                        name: 'user',
                        type: 'map',
                    },
                ])
            })
        })
    })*/

    describe('DELETE /api/v1/streams/:id', () => {

        it('happy path', async () => {
            const stream = await streamOwnerClient.createStream({
                id: `/test-stream/${Date.now()}`,
                name: 'stream-id-' + Date.now(),
            })
            expect(async () => {
                await stream.delete()
            }).not.toThrow()
        })

        it('deletes a stream with a permission', async () => {
            const stream = await streamOwnerClient.createStream({
                id: `/test-stream/${Date.now()}`,
                name: 'stream-id-' + Date.now(),
            })
            await stream.grantUserPermission(StreamPermission.GRANT, anonymousUser.address)
            expect(async () => {
                await stream.delete()  // FAIL
            }).not.toThrow()
        })

        it('deletes streams storage nodes', async () => {
            const stream = await streamOwnerClient.createStream({
                id: `/test-stream/${Date.now()}`,
                name: 'stream-id-' + Date.now(),
            })
            await stream.addToStorageNode(storageNodeTestConfig.address)
            expect(await streamOwnerClient.isStreamStoredInStorageNode(stream.id, storageNodeTestConfig.address)).toBe(true)
            await stream.delete()
            expect(await streamOwnerClient.isStreamStoredInStorageNode(stream.id, storageNodeTestConfig.address)).toBe(false)
        })
    })
})