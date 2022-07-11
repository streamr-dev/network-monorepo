import { fetchPrivateKeyWithGas, wait, waitForCondition } from 'streamr-test-utils'

import {
    createTestStream,
    getCreateClient,
    uid,
} from '../test-utils/utils'
import {
    getPublishTestMessages
} from '../test-utils/publish'
import { addAfterFn } from '../test-utils/jest-utils'
import { StreamrClient } from '../../src/StreamrClient'
import { counterId } from '../../src/utils/utils'
import { Stream } from '../../src/Stream'
import { StreamPermission } from '../../src/permission'
import { StreamMessage } from 'streamr-client-protocol'
import { DOCKER_DEV_STORAGE_NODE } from '../../src/ConfigTest'

jest.setTimeout(50000)
// this number should be at least 10, otherwise late subscribers might not join
// in time to see any realtime messages
const MAX_MESSAGES = 10

describe.skip('PubSub with multiple clients', () => { // TODO enable the test when it doesn't depend on PublishPipeline (via getPublishTestMessages)
    let stream: Stream
    let mainClient: StreamrClient
    let otherClient: StreamrClient
    let privateKey: string
    const errors: Error[] = []

    const createClient = getCreateClient()
    const addAfter = addAfterFn()

    beforeEach(async () => {
        privateKey = await fetchPrivateKeyWithGas()
        mainClient = await createClient({
            id: 'main',
            auth: {
                privateKey
            }
        })
        stream = await createTestStream(mainClient, module)
        await stream.addToStorageNode(DOCKER_DEV_STORAGE_NODE)
    })

    afterEach(async () => {
        expect(errors).toEqual([])
    })

    async function createPublisher(opts = {}) {
        const pubClient = await createClient({
            auth: {
                privateKey: await fetchPrivateKeyWithGas(),
            },
            ...opts
        })
        const publisherId = (await pubClient.getAddress()).toLowerCase()

        addAfter(async () => {
            counterId.clear(publisherId) // prevent overflows in counter
        })

        // pubClient.on('error', getOnError(errors))
        const pubUser = await pubClient.getAddress()
        await mainClient.setPermissions({
            streamId: stream.id,
            assignments: [
                // StreamPermission.SUBSCRIBE needed to check last
                { permissions: [StreamPermission.PUBLISH, StreamPermission.SUBSCRIBE], user: pubUser }
            ]
        })
        await pubClient.connect()
        return pubClient
    }

    async function createSubscriber(opts = {}) {
        const client = await createClient({
            id: 'subscriber',
            auth: {
                privateKey
            },
            ...opts,
        })

        // client.on('error', getOnError(errors))
        const user = await client.getAddress()

        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], user })
        await client.connect()
        return client
    }

    function checkMessages<T>(published: Record<string, T[]>, received: Record<string, T[]>) {
        for (const [key, msgs] of Object.entries(published)) {
            expect(received[key]).toEqual(msgs)
        }
    }

    describe('can get messages published from other client', () => {
        test('it works', async () => {
            otherClient = await createSubscriber()
            await mainClient.connect()

            const receivedMessagesOther: any[] = []
            const receivedMessagesMain: any[] = []
            // subscribe to stream from other client instance
            await otherClient.subscribe({
                stream: stream.id,
            }, (msg) => {
                receivedMessagesOther.push(msg)
            })
            // subscribe to stream from main client instance
            await mainClient.subscribe({
                stream: stream.id,
            }, (msg) => {
                receivedMessagesMain.push(msg)
            })
            const message = {
                msg: uid('message'),
            }
            // publish message on main client
            await mainClient.publish(stream, message)
            await wait(5000)
            // messages should arrive on both clients?
            expect(receivedMessagesMain).toEqual([message])
            expect(receivedMessagesOther).toEqual([message])
        })
        /*
        describe('subscriber disconnects after each message (uses resend)', () => {
            test('single subscriber', async () => {
                const maxMessages = MAX_MESSAGES + Math.floor(Math.random() * MAX_MESSAGES * 0.25)
                otherClient = await createSubscriber()
                await mainClient.connect()

                const receivedMessagesOther: any[] = []
                const msgs = receivedMessagesOther
                const otherDone = Defer()
                // subscribe to stream from other client instance
                await otherClient.subscribe({
                    stream: stream.id,
                }, (msg) => {
                    receivedMessagesOther.push(msg)
                    onConnectionMessage()

                    if (receivedMessagesOther.length === maxMessages) {
                        cancelled = true
                        otherDone.resolve(undefined)
                    }
                })

                let cancelled = false
                const localOtherClient = otherClient // capture so no chance of disconnecting wrong client
                let reconnected = Defer()

                const disconnect = async () => {
                    if (localOtherClient !== otherClient) {
                        throw new Error('not equal')
                    }

                    if (cancelled || msgs.length === MAX_MESSAGES) {
                        reconnected.resolve(undefined)
                        return
                    }

                    await wait(500) // some backend bug causes subs to stop working if we disconnect too quickly
                    if (cancelled || msgs.length === MAX_MESSAGES) {
                        reconnected.resolve(undefined)
                        return
                    }

                    if (localOtherClient !== otherClient) {
                        throw new Error('not equal')
                    }
                    await localOtherClient.nextConnection()
                    if (cancelled || msgs.length === MAX_MESSAGES) {
                        reconnected.resolve(undefined)
                        return
                    }

                    if (localOtherClient !== otherClient) {
                        throw new Error('not equal')
                    }
                    localOtherClient.connection.socket.close()
                    // wait for reconnection before possibly disconnecting again
                    await localOtherClient.nextConnection()
                    const p = reconnected
                    p.resolve(undefined)
                    reconnected = Defer()
                }

                const onConnectionMessage = jest.fn(() => {
                    // disconnect after every message
                    destroy()
                })

                const onConnected = jest.fn()
                const onDisconnected = jest.fn()
                otherClient.connection.on('connected', onConnected)
                otherClient.connection.on('disconnected', onDisconnected)
                addAfter(() => {
                    otherClient.connection.off('connected', onConnected)
                    otherClient.connection.off('disconnected', onDisconnected)
                })
                let t = 0
                const publishTestMessages = getPublishTestMessages(mainClient, {
                    stream,
                    delay: 600,
                    timestamp: () => {
                        t += 1
                        return t
                    },
                    waitForLast: true,
                    waitForLastTimeout: 10000,
                    waitForLastCount: maxMessages,
                })

                const published = await publishTestMessages(maxMessages)
                await otherDone

                expect(receivedMessagesOther).toEqual(published)
            }, 60000)

            test('publisher also subscriber', async () => {
                const maxMessages = MAX_MESSAGES + Math.floor(Math.random() * MAX_MESSAGES * 0.25)
                otherClient = await createSubscriber()
                await mainClient.connect()

                const receivedMessagesOther = []
                const msgs = receivedMessagesOther
                const receivedMessagesMain = []
                const mainDone = Defer()
                const otherDone = Defer()
                // subscribe to stream from other client instance
                await otherClient.subscribe({
                    stream: stream.id,
                }, (msg) => {
                    otherClient.debug('other %d of %d', receivedMessagesOther.length, maxMessages, msg.value)
                    receivedMessagesOther.push(msg)

                    if (receivedMessagesOther.length === maxMessages) {
                        otherDone.resolve()
                    }
                })

                const disconnect = pLimitFn(async () => {
                    if (msgs.length === maxMessages) { return }
                    otherClient.debug('disconnecting...', msgs.length)
                    otherClient.connection.socket.close()
                    // wait for reconnection before possibly disconnecting again
                    await otherClient.nextConnection()
                    otherClient.debug('reconnected...', msgs.length)
                })

                const onConnectionMessage = jest.fn(() => {
                    disconnect.clear()
                    // disconnect after every message
                    destroy()
                })

                otherClient.connection.on(ControlMessage.TYPES.BroadcastMessage, onConnectionMessage)
                otherClient.connection.on(ControlMessage.TYPES.UnicastMessage, onConnectionMessage)
                // subscribe to stream from main client instance
                await mainClient.subscribe({
                    stream: stream.id,
                }, (msg) => {
                    mainClient.debug('main %d of %d', receivedMessagesOther.length, maxMessages, msg.value)
                    receivedMessagesMain.push(msg)
                    if (receivedMessagesMain.length === maxMessages) {
                        mainDone.resolve()
                    }
                })

                let t = 0

                const publishTestMessages = getPublishTestMessages(mainClient, {
                    stream,
                    delay: 600,
                    waitForLast: true,
                    waitForLastTimeout: 10000,
                    waitForLastCount: maxMessages,
                    timestamp: () => {
                        t += 1
                        return t
                    },
                })
                const published = await publishTestMessages(maxMessages)
                mainClient.debug('publish done')
                mainDone.then(() => mainClient.debug('done')).catch(() => {})
                otherDone.then(() => otherClient.debug('done')).catch(() => {})
                await mainDone
                await otherDone

                // messages should arrive on both clients?
                expect(receivedMessagesMain).toEqual(published)
                expect(receivedMessagesOther).toEqual(published)
            }, 60000)
        })
        */
    })

    describe('multiple publishers', () => {
        test('works with multiple publishers on a single stream', async () => {
            // this creates two subscriber clients and multiple publisher clients
            // all subscribing and publishing to same stream
            await mainClient.connect()

            otherClient = await createSubscriber()

            const receivedMessagesOther: Record<string, any[]> = {}
            const receivedMessagesMain: Record<string, any[]> = {}
            // subscribe to stream from other client instance
            await otherClient.subscribe({
                stream: stream.id,
            }, (msg, streamMessage) => {
                const msgs = receivedMessagesOther[streamMessage.getPublisherId().toLowerCase()] || []
                msgs.push(msg)
                receivedMessagesOther[streamMessage.getPublisherId().toLowerCase()] = msgs
            })

            // subscribe to stream from main client instance
            await mainClient.subscribe({
                stream: stream.id,
            }, (msg, streamMessage) => {
                const msgs = receivedMessagesMain[streamMessage.getPublisherId().toLowerCase()] || []
                msgs.push(msg)
                receivedMessagesMain[streamMessage.getPublisherId().toLowerCase()] = msgs
            })

            /* eslint-disable no-await-in-loop */
            const publishers = []
            for (let i = 0; i < 3; i++) {
                publishers.push(await createPublisher({
                    id: `publisher-${i}`,
                }))
            }
            /* eslint-enable no-await-in-loop */
            const published: Record<string, any[]> = {}
            await Promise.all(publishers.map(async (pubClient) => {
                const publisherId = (await pubClient.getAddress()).toLowerCase()
                addAfter(() => {
                    counterId.clear(publisherId) // prevent overflows in counter
                })
                const publishTestMessages = getPublishTestMessages(pubClient, stream, {
                    // delay: 500 + Math.random() * 1500,
                    waitForLast: true,
                    waitForLastTimeout: 20000,
                    waitForLastCount: MAX_MESSAGES * publishers.length,
                    createMessage: ({ batchId }) => ({
                        batchId,
                        value: counterId(publisherId),
                    }),
                })
                published[publisherId] = await publishTestMessages(MAX_MESSAGES)
            }))

            await waitForCondition(() => {
                try {
                    checkMessages(published, receivedMessagesMain)
                    checkMessages(published, receivedMessagesOther)
                    return true
                } catch (err) {
                    return false
                }
            }, 35000).catch((err) => {
                checkMessages(published, receivedMessagesMain)
                checkMessages(published, receivedMessagesOther)
                throw err
            })

            checkMessages(published, receivedMessagesMain)
            checkMessages(published, receivedMessagesOther)
        })

        // late subscriber test is super unreliable. Doesn't seem to be a good way to make the
        // late subscriber reliably get all of both realtime and resent messages
        test.skip('works with multiple publishers on one stream with late subscriber (resend)', async () => {
            // this creates two subscriber clients and multiple publisher clients
            // all subscribing and publishing to same stream
            // the otherClient subscribes after the 3rd message hits storage
            otherClient = await createSubscriber()
            await mainClient.connect()

            const receivedMessagesOther: Record<string, any[]> = {}
            const receivedMessagesMain: Record<string, any[]> = {}

            // subscribe to stream from main client instance
            const mainSub = await mainClient.subscribe({
                stream: stream.id,
            }, (msg, streamMessage) => {
                const key = streamMessage.getPublisherId().toLowerCase()
                const msgs = receivedMessagesMain[key] || []
                msgs.push(msg)
                receivedMessagesMain[key] = msgs
                if (Object.values(receivedMessagesMain).every((m) => m.length === MAX_MESSAGES)) {
                    mainSub.unsubscribe()
                }
            })

            /* eslint-disable no-await-in-loop */
            const publishers = []
            for (let i = 0; i < 3; i++) {
                publishers.push(await createPublisher({
                    id: `publisher-${i}`,
                }))
            }

            /* eslint-enable no-await-in-loop */
            let counter = 0
            const published: Record<string, any[]> = {}
            await Promise.all(publishers.map(async (pubClient) => {
                // const vaitForStorage = getWaitForStorage(pubClient, {
                //     stream,
                //     timeout: 35000,
                //     count: MAX_MESSAGES * publishers.length,
                // })

                const publisherId = (await pubClient.getAddress()).toLowerCase()
                addAfter(() => {
                    counterId.clear(publisherId) // prevent overflows in counter
                })

                const publishTestMessages = getPublishTestMessages(pubClient, stream, {
                    waitForLast: true,
                    waitForLastTimeout: 35000,
                    waitForLastCount: MAX_MESSAGES * publishers.length,
                    delay: 500 + Math.random() * 1000,
                    createMessage: (msg) => ({
                        ...msg,
                        publisherId,
                    }),
                })

                async function addLateSubscriber(lastMessage: StreamMessage) {
                    // late subscribe to stream from other client instance
                    const lateSub = await otherClient.subscribe({
                        stream: stream.id,
                        resend: {
                            from: lastMessage.getMessageRef()
                        }
                    }, (msg, streamMessage) => {
                        const key = streamMessage.getPublisherId().toLowerCase()
                        const msgs = receivedMessagesOther[key] || []
                        msgs.push(msg)
                        receivedMessagesOther[key] = msgs
                    })

                    addAfter(async () => {
                        await lateSub.unsubscribe()
                    })
                }

                let firstMessage: StreamMessage
                const msgs = await publishTestMessages(1, {
                    async afterEach(streamMessage) {
                        firstMessage = streamMessage
                    }
                }) // ensure first message stored
                // await waitForStorage
                published[publisherId] = msgs.concat(await publishTestMessages(MAX_MESSAGES - 1, {
                    waitForLast: true,
                    async afterEach() {
                        counter += 1
                        if (counter === 3) {
                            await addLateSubscriber(firstMessage)
                        }
                    }
                }))
            }))

            await waitForCondition(() => {
                try {
                    checkMessages(published, receivedMessagesMain)
                    checkMessages(published, receivedMessagesOther)
                    return true
                } catch (err) {
                    return false
                }
            }, 30000, 300).catch((err) => {
                // convert timeout to actual error
                checkMessages(published, receivedMessagesMain)
                checkMessages(published, receivedMessagesOther)
                throw err
            })
        })
    })

    test('works with multiple publishers on one stream', async () => {
        await mainClient.connect()

        otherClient = await createClient({
            auth: {
                privateKey: await fetchPrivateKeyWithGas()
            }
        })
        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], public: true })
        await otherClient.connect()

        const receivedMessagesOther: Record<string, any[]> = {}
        const receivedMessagesMain: Record<string, any[]> = {}
        // subscribe to stream from other client instance
        await otherClient.subscribe({
            stream: stream.id,
        }, (msg, streamMessage) => {
            const key = streamMessage.getPublisherId().toLowerCase()
            const msgs = receivedMessagesOther[key] || []
            msgs.push(msg)
            receivedMessagesOther[key] = msgs
        })

        // subscribe to stream from main client instance
        await mainClient.subscribe({
            stream: stream.id,
        }, (msg, streamMessage) => {
            const key = streamMessage.getPublisherId().toLowerCase()
            const msgs = receivedMessagesMain[key] || []
            msgs.push(msg)
            receivedMessagesMain[key] = msgs
        })

        /* eslint-disable no-await-in-loop */
        const publishers = []
        for (let i = 0; i < 1; i++) {
            publishers.push(await createPublisher())
        }

        /* eslint-enable no-await-in-loop */
        const published: Record<string, any[]> = {}
        await Promise.all(publishers.map(async (pubClient) => {
            const publisherId = (await pubClient.getAddress()).toLowerCase()
            const publishTestMessages = getPublishTestMessages(pubClient, stream, {
                waitForLast: true,
                waitForLastTimeout: 35000,
            })

            await publishTestMessages(MAX_MESSAGES, {
                // delay: 500 + Math.random() * 1500,
                afterEach(msg) {
                    published[publisherId] = published[publisherId] || []
                    published[publisherId].push(msg.getParsedContent())
                }
            })
        }))

        await waitForCondition(() => {
            try {
                checkMessages(published, receivedMessagesMain)
                checkMessages(published, receivedMessagesOther)
                return true
            } catch (err) {
                return false
            }
        }, 25000).catch(() => {
            checkMessages(published, receivedMessagesMain)
            checkMessages(published, receivedMessagesOther)
        })
    })

    // late subscriber test is super unreliable. Doesn't seem to be a good way to make the
    // late subscriber reliably get all of both realtime and resent messages
    test.skip('works with multiple publishers on one stream with late subscriber (resend)', async () => {
        const published: Record<string, any[]> = {}
        await mainClient.connect()

        otherClient = await createClient({
            auth: {
                privateKey: await fetchPrivateKeyWithGas()
            }
        })
        // otherClient.on('error', getOnError(errors))
        const otherUser = await otherClient.getAddress()

        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], user: otherUser })
        await otherClient.connect()

        const receivedMessagesOther: Record<string, any[]> = {}
        const receivedMessagesMain: Record<string, any[]> = {}

        // subscribe to stream from main client instance
        const mainSub = await mainClient.subscribe({
            stream: stream.id,
        }, (msg, streamMessage) => {
            const key = streamMessage.getPublisherId().toLowerCase()
            const msgs = receivedMessagesMain[key] || []
            msgs.push(msg)
            receivedMessagesMain[key] = msgs
            if (Object.values(receivedMessagesMain).every((m) => m.length === MAX_MESSAGES)) {
                mainSub.unsubscribe()
            }
        })

        /* eslint-disable no-await-in-loop */
        const publishers = []
        for (let i = 0; i < 3; i++) {
            publishers.push(await createPublisher())
        }

        let counter = 0
        /* eslint-enable no-await-in-loop */
        await Promise.all(publishers.map(async (pubClient) => {
            // const waitForStorage = getWaitForStorage(pubClient, {
            //     stream,
            //     timeout: 35000,
            //     count: MAX_MESSAGES * publishers.length,
            // })

            const publisherId = (await pubClient.getAddress()).toString().toLowerCase()
            const publishTestMessages = getPublishTestMessages(pubClient, stream, {
                waitForLast: true,
                waitForLastTimeout: 35000,
                waitForLastCount: MAX_MESSAGES * publishers.length,
                delay: 500 + Math.random() * 1000,
            })

            async function addLateSubscriber(lastMessage: StreamMessage) {
                // late subscribe to stream from other client instance
                const lateSub = await otherClient.subscribe({
                    stream: stream.id,
                    resend: {
                        from: lastMessage.getMessageRef()
                    }
                }, (msg, streamMessage) => {
                    const key = streamMessage.getPublisherId().toLowerCase()
                    const msgs = receivedMessagesOther[key] || []
                    msgs.push(msg)
                    receivedMessagesOther[key] = msgs
                })

                addAfter(async () => {
                    await lateSub.unsubscribe()
                })
            }

            let firstMessage: StreamMessage
            const msgs = await publishTestMessages(1, {
                async afterEach(streamMessage) {
                    firstMessage = streamMessage
                }
            }) // ensure first message stored
            // await waitForStorage
            published[publisherId] = msgs.concat(await publishTestMessages(MAX_MESSAGES - 1, {
                async afterEach() {
                    counter += 1
                    if (counter === 3) {
                        // late subscribe to stream from other client instance
                        await addLateSubscriber(firstMessage)
                    }
                }
            }))
        }))

        await waitForCondition(() => {
            try {
                checkMessages(published, receivedMessagesMain)
                checkMessages(published, receivedMessagesOther)
                return true
            } catch (err) {
                return false
            }
        }, 25000, 300).catch(() => {
            checkMessages(published, receivedMessagesMain)
            checkMessages(published, receivedMessagesOther)
        })
    })
})
