/**
 * Wrap a network node.
 */
import { inject, Lifecycle, scoped } from 'tsyringe'
import { NetworkNodeOptions, createNetworkNode, NetworkNode, MetricsContext } from 'streamr-network'
import { uuid } from './utils/uuid'
import { instanceId } from './utils/utils'
import { pOnce } from './utils/promises'
import { Context } from './utils/Context'
import { NetworkConfig, ConfigInjectionToken, TrackerRegistrySmartContract } from './Config'
import { StreamMessage, StreamPartID, ProxyDirection } from 'streamr-client-protocol'
import { DestroySignal } from './DestroySignal'
import { EthereumConfig, generateEthereumAccount, getMainnetProvider } from './Ethereum'
import { getTrackerRegistryFromContract } from './registry/getTrackerRegistryFromContract'
import { Authentication, AuthenticationInjectionToken } from './Authentication'
import { createSigners } from './utils/createSigners'

// TODO should we make getNode() an internal method, and provide these all these services as client methods?
export interface NetworkNodeStub {
    getNodeId: () => string
    addMessageListener: (listener: (msg: StreamMessage) => void) => void
    removeMessageListener: (listener: (msg: StreamMessage) => void) => void
    subscribe: (streamPartId: StreamPartID) => void
    subscribeAndWaitForJoin: (streamPart: StreamPartID, timeout?: number) => Promise<number>
    waitForJoinAndPublish: (msg: StreamMessage, timeout?: number) => Promise<number>
    unsubscribe: (streamPartId: StreamPartID) => void
    publish: (streamMessage: StreamMessage) => void
    getStreamParts: () => Iterable<StreamPartID>
    getNeighbors: () => ReadonlyArray<string>
    getNeighborsForStreamPart: (streamPartId: StreamPartID) => ReadonlyArray<string>
    getRtt: (nodeId: string) => number | undefined
    setExtraMetadata: (metadata: Record<string, unknown>) => void
    getMetricsContext: () => MetricsContext
    hasStreamPart: (streamPartId: StreamPartID) => boolean
    hasProxyConnection: (streamPartId: StreamPartID, contactNodeId: string, direction: ProxyDirection) => boolean
}

/**
 * Wrap a network node.
 * Lazily creates & starts node on first call to getNode().
 */
@scoped(Lifecycle.ContainerScoped)
export class BrubeckNode implements Context {
    private cachedNode?: NetworkNode
    private networkConfig: NetworkConfig
    private ethereumConfig: EthereumConfig
    readonly id
    readonly debug
    private startNodeCalled = false
    private startNodeComplete = false

    constructor(
        context: Context,
        private destroySignal: DestroySignal,
        @inject(AuthenticationInjectionToken) private authentication: Authentication,
        @inject(ConfigInjectionToken.Network) networkConfig: NetworkConfig,
        @inject(ConfigInjectionToken.Ethereum) ethereumConfig: EthereumConfig
    ) {
        this.networkConfig = networkConfig
        this.ethereumConfig = ethereumConfig
        this.id = instanceId(this)
        this.debug = context.debug.extend(this.id)
        destroySignal.onDestroy.listen(this.destroy)
    }

    private assertNotDestroyed(): void {
        this.destroySignal.assertNotDestroyed(this)
    }

    private async getNormalizedNetworkOptions(): Promise<NetworkNodeOptions> {
        if ((this.networkConfig.trackers as TrackerRegistrySmartContract).contractAddress) {
            const trackerRegistry = await getTrackerRegistryFromContract({
                contractAddress: (this.networkConfig.trackers as TrackerRegistrySmartContract).contractAddress,
                jsonRpcProvider: getMainnetProvider(this.ethereumConfig)
            })
            return {
                ...this.networkConfig,
                trackers: trackerRegistry.getAllTrackers()
            }
        }
        return this.networkConfig as NetworkNodeOptions
    }

    private async initNode(): Promise<NetworkNode> {
        this.assertNotDestroyed()
        if (this.cachedNode) { return this.cachedNode }

        let id = this.networkConfig.id
        if (id == null || id === '') {
            id = await this.generateId()
        } else if (!this.authentication.isAuthenticated()) {
            throw new Error(`cannot set explicit nodeId ${id} without authentication`)
        } else {
            const ethereumAddress = await this.authentication.getAddress()
            if (!id.toLowerCase().startsWith(ethereumAddress.toLowerCase())) {
                throw new Error(`given node id ${id} not compatible with authenticated wallet ${ethereumAddress}`)
            }
        }

        this.debug('initNode', id)
        const networkOptions = await this.getNormalizedNetworkOptions()
        const node = createNetworkNode({
            disconnectionWaitTime: 200,
            ...networkOptions,
            id,
            metricsContext: new MetricsContext(),
            signers: createSigners(this.authentication)
        })

        if (!this.destroySignal.isDestroyed()) {
            this.cachedNode = node
        }

        return node
    }

    private async generateId(): Promise<string> {
        if (this.authentication.isAuthenticated()) {
            const address = await this.authentication.getAddress()
            return `${address}#${uuid()}`
            // eslint-disable-next-line no-else-return
        } else {
            return generateEthereumAccount().address
        }
    }

    /**
     * Stop network node, or wait for it to stop if already stopping.
     * Subsequent calls to getNode/start will fail.
     */
    private destroy = pOnce(async () => {
        this.debug('destroy >>')

        const node = this.cachedNode
        this.cachedNode = undefined
        // stop node only if started or in progress
        if (node && this.startNodeCalled) {
            this.debug('stopping node >>')
            if (!this.startNodeComplete) {
                // wait for start to finish before stopping node
                const startNodeTask = this.startNodeTask()
                this.startNodeTask.reset() // allow subsequent calls to fail
                await startNodeTask
            }

            await node.stop()
            this.debug('stopping node <<')
        }
        this.startNodeTask.reset() // allow subsequent calls to fail

        this.debug('destroy <<')
    })

    /**
     * Start network node, or wait for it to start if already started.
     */
    private startNodeTask = pOnce(async () => {
        this.startNodeCalled = true
        this.debug('start >>')
        try {
            const node = await this.initNode()
            if (!this.destroySignal.isDestroyed()) {
                await node.start()
            }

            if (this.destroySignal.isDestroyed()) {
                this.debug('stopping node before init >>')
                await node.stop()
                this.debug('stopping node before init <<')
            }
            this.assertNotDestroyed()
            return node
        } finally {
            this.startNodeComplete = true
            this.debug('start <<')
        }
    })

    startNode: () => Promise<unknown> = this.startNodeTask

    getNode: () => Promise<NetworkNodeStub> = this.startNodeTask

    async getNodeId(): Promise<string> {
        const node = await this.getNode()
        return node.getNodeId()
    }

    /**
     * Calls publish on node after starting it.
     * Basically a wrapper around: (await getNode()).publish(…)
     * but will be sync in case that node is already started.
     * Zalgo intentional. See below.
     */
    publishToNode(streamMessage: StreamMessage): void | Promise<void> {
        // NOTE: function is intentionally not async for performance reasons.
        // Will call cachedNode.publish immediately if cachedNode is set.
        // Otherwise will wait for node to start.
        this.debug('publishToNode >> %o', streamMessage.getMessageID())
        try {
            this.destroySignal.assertNotDestroyed(this)

            if (this.isStarting()) {
                // use .then instead of async/await so
                // this.cachedNode.publish call can be sync
                return this.startNodeTask().then((node) => {
                    return node.publish(streamMessage)
                })
            }

            return this.cachedNode!.publish(streamMessage)
        } finally {
            this.debug('publishToNode << %o', streamMessage.getMessageID())
        }
    }

    async openProxyConnection(streamPartId: StreamPartID, nodeId: string, direction: ProxyDirection): Promise<void> {
        try {
            if (this.isStarting()) {
                await this.startNodeTask()
            }
            await this.cachedNode!.openProxyConnection(streamPartId, nodeId, direction)
        } finally {
            this.debug('openProxyConnectionOnStream << %o', streamPartId, nodeId)
        }
    }

    async closeProxyConnection(streamPartId: StreamPartID, nodeId: string, direction: ProxyDirection): Promise<void> {
        try {
            if (this.isStarting()) {
                return
            }
            await this.cachedNode!.closeProxyConnection(streamPartId, nodeId, direction)
        } finally {
            this.debug('closeProxyConnectionOnStream << %o', streamPartId, nodeId)
        }
    }

    private isStarting(): boolean {
        return !this.cachedNode || !this.startNodeComplete
    }
}

