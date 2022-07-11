import 'reflect-metadata'
import { fetchPrivateKeyWithGas, wait } from 'streamr-test-utils'
import { getPublishTestMessages } from '../test-utils/publish'
import { LeaksDetector } from '../test-utils/LeaksDetector'
import { StreamrClient } from '../../src/StreamrClient'
import { initContainer } from '../../src/Container'
import { container as rootContainer, DependencyContainer } from 'tsyringe'
import { writeHeapSnapshot } from 'v8'
import { Subscription } from '../../src/subscribe/Subscription'
import { counterId } from '../../src/utils/utils'
import { Defer } from '../../src/utils/Defer'
import { ConfigTest } from '../../src/ConfigTest'
import { createStrictConfig, StrictStreamrClientConfig } from '../../src/Config'
import { ethers } from 'ethers'
import { Context } from '../../src/utils/Context'
import { BrubeckNode } from '../../src/BrubeckNode'
import { StorageNodeRegistry } from '../../src/registry/StorageNodeRegistry'
import { StreamRegistryCached } from '../../src/registry/StreamRegistryCached'
import { Resends } from '../../src/subscribe/Resends'
import { Publisher } from '../../src/publish/Publisher'
import { Subscriber } from '../../src/subscribe/Subscriber'
import { GroupKeyStoreFactory } from '../../src/encryption/GroupKeyStoreFactory'
import { DestroySignal } from '../../src/DestroySignal'
import { Debug } from '../test-utils/utils'

const Dependencies = {
    Context,
    BrubeckNode,
    StorageNodeRegistry,
    StreamRegistryCached,
    Resends,
    Publisher,
    Subscriber,
    GroupKeyStoreFactory,
    DestroySignal
}

const debug = Debug('test')

/**
 * Write a heap snapshot file if WRITE_SNAPSHOTS env var is set.
 */
function snapshot(): string {
    if (!process.env.WRITE_SNAPSHOTS) { return '' }
    debug('heap snapshot >>')
    const value = writeHeapSnapshot()
    debug('heap snapshot <<', value)
    return value
}

const MAX_MESSAGES = 5
const TIMEOUT = 30000

describe.skip('MemoryLeaks', () => { // TODO enable the test when it doesn't depend on PublishPipeline (via getPublishTestMessages)
    let leaksDetector: LeaksDetector

    beforeEach(() => {
        leaksDetector = new LeaksDetector()
        leaksDetector.ignoreAll(rootContainer)
        leaksDetector.ignoreAll(ethers)
        snapshot()
    })

    afterEach(async () => {
        expect(leaksDetector).toBeTruthy()
        if (!leaksDetector) { return }
        const detector = leaksDetector
        await wait(1000)
        snapshot()
        await detector.checkNoLeaks() // this is very slow
        detector.clear()
    }, TIMEOUT)

    describe('client container', () => {
        let createContainer: (opts?: any) => Promise<any>
        beforeAll(() => {
            createContainer = async (opts: any = {}): Promise<{
                config: StrictStreamrClientConfig;
                childContainer: DependencyContainer;
                rootContext: any;}> => {
                const config = createStrictConfig({
                    ...ConfigTest,
                    auth: {
                        privateKey: await fetchPrivateKeyWithGas(),
                    },
                    ...opts,
                })
                const childContainer = rootContainer.createChildContainer()
                const rootContext = initContainer(config, childContainer)
                return { config, childContainer, rootContext }
            }
        })

        /* Uncomment to debug get all failure
        for (const [key, value] of Object.entries(Dependencies)) {
            // eslint-disable-next-line no-loop-func
            test(`container get ${key}`, async () => {
                const { config, childContainer, rootContext } = createContainer()
                const destroySignal = childContainer.resolve<any>(Dependencies.DestroySignal)
                const result = childContainer.resolve<any>(value as any)
                expect(result).toBeTruthy()
                await wait(100)
                leaksDetector.addAll(rootContext.id, { config, childContainer, result })
                if (result && typeof result.stop === 'function') {
                    await result.stop()
                }
                await destroySignal.trigger()
                childContainer.clearInstances()
            })
        }
        */

        test('container get all', async () => {
            const { config, childContainer, rootContext } = await createContainer()
            const toStop = []
            const destroySignal = childContainer.resolve(Dependencies.DestroySignal)
            for (const [key, value] of Object.entries(Dependencies)) {
                const result = childContainer.resolve(value as any)
                expect(result).toBeTruthy()

                if (result && typeof result.stop === 'function') {
                    toStop.push(result)
                }
                leaksDetector.addAll(key, result)
            }
            await wait(100)
            leaksDetector.addAll(rootContext.id, { config, childContainer })
            await destroySignal.trigger()
            for (const result of toStop) {
                // eslint-disable-next-line no-await-in-loop
                await result.stop()
            }
            childContainer.clearInstances()
        })
    })

    describe('StreamrClient', () => {
        let createClient: () => Promise<StreamrClient>
        beforeAll(() => {
            createClient = async (opts: any = {}) => {
                const c = new StreamrClient({
                    ...ConfigTest,
                    auth: {
                        privateKey: await fetchPrivateKeyWithGas(),
                    },
                    ...opts,
                })
                return c
            }
        })

        describe('with client', () => {
            test('creating client', async () => {
                const client = await createClient()
                leaksDetector.addAll(client.id, client)
            })

            test('connect + destroy', async () => {
                const client = await createClient()
                await client.connect()
                leaksDetector.addAll(client.id, client)
                await client.destroy()
            })
        })

        describe('stream', () => {
            let client: StreamrClient

            beforeEach(async () => {
                client = await createClient()
                leaksDetector.addAll(client.id, client)
                await client.connect()
            })

            afterEach(async () => {
                const c = client
                // @ts-expect-error doesn't want us to unassign but it's ok
                client = undefined // unassign so can gc
                await c.destroy()
            })

            test('create', async () => {
                await client.createStream({
                    id: `/${counterId('stream')}-${Date.now()}`
                })
            })

            test('publish', async () => {
                const stream = await client.createStream({
                    id: `/${counterId('stream')}-${Date.now()}`
                })
                const publishTestMessages = getPublishTestMessages(client, stream, {
                    retainMessages: false,
                })

                await publishTestMessages(5)
                await client.destroy()
                leaksDetector.add('stream', stream)
                await wait(3000)
            }, TIMEOUT)

            describe('publish + subscribe', () => {
                it('does not leak subscription', async () => {
                    const stream = await client.createStream({
                        id: `/${counterId('stream')}-${Date.now()}`
                    })
                    const sub = await client.subscribe(stream)
                    leaksDetector.addAll(sub.id, sub)
                    const publishTestMessages = getPublishTestMessages(client, stream, {
                        retainMessages: false,
                    })

                    await publishTestMessages(MAX_MESSAGES)
                }, TIMEOUT)

                test('subscribe using async iterator', async () => {
                    const stream = await client.createStream({
                        id: `/${counterId('stream')}-${Date.now()}`
                    })
                    const sub = await client.subscribe(stream)
                    leaksDetector.addAll(sub.id, sub)
                    const publishTestMessages = getPublishTestMessages(client, stream, {
                        retainMessages: false,
                    })

                    await publishTestMessages(MAX_MESSAGES)
                    const received = []
                    for await (const msg of sub) {
                        received.push(msg)
                        leaksDetector.add('streamMessage', msg)
                        if (received.length === MAX_MESSAGES) {
                            break
                        }
                    }
                }, TIMEOUT)

                test('subscribe using onMessage callback', async () => {
                    const stream = await client.createStream({
                        id: `/${counterId('stream')}-${Date.now()}`
                    })

                    const publishTestMessages = getPublishTestMessages(client, stream, {
                        retainMessages: false,
                    })
                    const received: any[] = []
                    const sub = await client.subscribe(stream, (msg, streamMessage) => {
                        received.push(msg)
                        leaksDetector.add('messageContent', msg)
                        leaksDetector.add('streamMessage', streamMessage)
                        if (received.length === MAX_MESSAGES) {
                            sub.unsubscribe()
                        }
                    })

                    leaksDetector.add(sub.id, sub)

                    await publishTestMessages(MAX_MESSAGES)
                    await wait(1000)
                }, TIMEOUT)

                test('subscriptions can be collected before all subscriptions removed', async () => {
                    // leaksDetector = new LeaksDetector()
                    const stream = await client.createStream({
                        id: `/${counterId('stream')}-${Date.now()}`
                    })

                    const publishTestMessages = getPublishTestMessages(client, stream, {
                        retainMessages: false,
                    })
                    const sub1Done = Defer()
                    const received1: any[] = []
                    const SOME_MESSAGES = Math.floor(MAX_MESSAGES / 2)
                    let sub1: Subscription<any> | undefined = await client.subscribe(stream, async (msg) => {
                        received1.push(msg)
                        if (received1.length === SOME_MESSAGES) {
                            if (!sub1) { return }
                            sub1.unsubscribe()
                            // unsub early
                            sub1Done.resolve(undefined)
                        }
                    })
                    const sub1LeakId = 'sub1 ' + sub1.id
                    leaksDetector.add(sub1LeakId, sub1)

                    const sub2Done = Defer()
                    const received2: any[] = []
                    const sub2 = await client.subscribe(stream, (msg) => {
                        received2.push(msg)
                        if (received2.length === MAX_MESSAGES) {
                            // don't unsubscribe yet, this shouldn't affect sub1 from being collected
                            sub2Done.resolve(undefined)
                        }
                    })
                    leaksDetector.add('sub2 ' + sub2.id, sub2)

                    await publishTestMessages(MAX_MESSAGES)
                    await sub1Done
                    await sub2Done
                    // eslint-disable-next-line require-atomic-updates
                    sub1 = undefined
                    await wait(1000)
                    snapshot()
                    // sub1 should have been collected even though sub2 is still subscribed
                    await leaksDetector.checkNoLeaksFor(sub1LeakId)
                    expect(received1).toHaveLength(SOME_MESSAGES)
                    expect(received2).toHaveLength(MAX_MESSAGES)
                    await sub2.unsubscribe()
                    await wait(1000)
                }, TIMEOUT)
            })
        })
    })
})
