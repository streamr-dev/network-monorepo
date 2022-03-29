import { Contract } from '@ethersproject/contracts'
import { Provider } from '@ethersproject/providers'
import debug from 'debug'
import type { NodeRegistry as NodeRegistryContract } from './ethereumArtifacts/NodeRegistry'
import type { StreamStorageRegistry as StreamStorageRegistryContract } from './ethereumArtifacts/StreamStorageRegistry'
import NodeRegistryArtifact from './ethereumArtifacts/NodeRegistryAbi.json'
import StreamStorageRegistryArtifact from './ethereumArtifacts/StreamStorageRegistry.json'
import { StreamQueryResult } from './StreamRegistry'
import { scoped, Lifecycle, inject, DependencyContainer } from 'tsyringe'
import { BrubeckContainer } from './Container'
import { ConfigInjectionToken, StrictStreamrClientConfig } from './Config'
import { Stream, StreamProperties } from './Stream'
import Ethereum from './Ethereum'
import { NotFoundError } from './authFetch'
import { EthereumAddress, StreamID, toStreamID } from 'streamr-client-protocol'
import { StreamIDBuilder } from './StreamIDBuilder'
import { waitForTx, withErrorHandlingAndLogging } from './utils/contract'
import { SynchronizedGraphQLClient, createWriteContract } from './utils/SynchronizedGraphQLClient'
import { StreamrClientEventEmitter, StreamrClientEvents, initEventGateway } from './events'

const log = debug('StreamrClient:StorageNodeRegistry')

export type StorageNodeAssignmentEvent = {
    streamId: string,
    nodeAddress: EthereumAddress,
    blockNumber: number
}

type NodeQueryResult = {
    id: string,
    metadata: string,
    lastseen: string,
}

type StoredStreamQueryResult = {
    stream: {
        id: string,
        metadata: string,
        storageNodes: NodeQueryResult[],
    } | null,
}

type AllNodesQueryResult = {
    nodes: NodeQueryResult[],
}
type SingleNodeQueryResult = {
    node: NodeQueryResult,
}

type StorageNodeQueryResult = {
    node: {
        id: string,
        metadata: string,
        lastSeen: string,
        storedStreams: StreamQueryResult[]
    }
    _meta: {
        block: {
            number: number
        }
    }
}

@scoped(Lifecycle.ContainerScoped)
export class StorageNodeRegistry {

    private clientConfig: StrictStreamrClientConfig
    private chainProvider: Provider
    private streamStorageRegistryContractReadonly: StreamStorageRegistryContract
    private nodeRegistryContract?: NodeRegistryContract
    private streamStorageRegistryContract?: StreamStorageRegistryContract

    constructor(
        @inject(BrubeckContainer) private container: DependencyContainer,
        @inject(Ethereum) private ethereum: Ethereum,
        @inject(StreamIDBuilder) private streamIdBuilder: StreamIDBuilder,
        @inject(SynchronizedGraphQLClient) private graphQLClient: SynchronizedGraphQLClient,
        @inject(ConfigInjectionToken.Root) clientConfig: StrictStreamrClientConfig,
        @inject(StreamrClientEventEmitter) eventEmitter: StreamrClientEventEmitter
    ) {
        this.clientConfig = clientConfig
        this.chainProvider = this.ethereum.getStreamRegistryChainProvider()
        this.streamStorageRegistryContractReadonly = withErrorHandlingAndLogging(
            new Contract(this.clientConfig.streamStorageRegistryChainAddress, StreamStorageRegistryArtifact, this.chainProvider),
            'streamStorageRegistry'
        ) as StreamStorageRegistryContract
        this.initStreamAssignmentEventListener('addToStorageNode', 'Added', eventEmitter)
        this.initStreamAssignmentEventListener('removeFromStorageNode', 'Removed', eventEmitter)
    }

    initStreamAssignmentEventListener(clientEvent: keyof StreamrClientEvents, contractEvent: string, eventEmitter: StreamrClientEventEmitter) {
        type Listener = (streamId: string, nodeAddress: string, extra: any) => void
        initEventGateway<StreamrClientEvents, Listener>(
            clientEvent,
            () => {
                const listener = (streamId: string, nodeAddress: string, extra: any) => {
                    const payload = {
                        streamId,
                        nodeAddress,
                        blockNumber: extra.blockNumber
                    }
                    eventEmitter.emit(clientEvent, payload)
                }
                this.streamStorageRegistryContractReadonly.on(contractEvent, listener)
                return listener
            },
            (listener: Listener) => {
                this.streamStorageRegistryContractReadonly.off(contractEvent, listener)
            },
            eventEmitter
        )
    }

    // --------------------------------------------------------------------------------------------
    // Send transactions to the StreamRegistry or StreamStorageRegistry contract
    // --------------------------------------------------------------------------------------------

    private async connectToNodeRegistryContract() {
        if (!this.nodeRegistryContract) {
            const chainSigner = await this.ethereum.getStreamRegistryChainSigner()
            this.nodeRegistryContract = createWriteContract<NodeRegistryContract>(
                this.clientConfig.storageNodeRegistryChainAddress,
                NodeRegistryArtifact,
                chainSigner,
                'storageNodeRegistry',
                this.graphQLClient
            )
            this.streamStorageRegistryContract = createWriteContract<StreamStorageRegistryContract>(
                this.clientConfig.streamStorageRegistryChainAddress,
                StreamStorageRegistryArtifact,
                chainSigner,
                'streamStorageRegistry',
                this.graphQLClient
            )
        }
    }

    async createOrUpdateNodeInStorageNodeRegistry(nodeMetadata: string): Promise<void> {
        log('createOrUpdateNodeInStorageNodeRegistry %s -> %s', nodeMetadata)
        await this.connectToNodeRegistryContract()
        const ethersOverrides = this.ethereum.getStreamRegistryOverrides()
        await waitForTx(this.nodeRegistryContract!.createOrUpdateNodeSelf(nodeMetadata, ethersOverrides))
    }

    async removeNodeFromStorageNodeRegistry(): Promise<void> {
        log('removeNodeFromStorageNodeRegistry called')
        await this.connectToNodeRegistryContract()
        const ethersOverrides = this.ethereum.getStreamRegistryOverrides()
        await waitForTx(this.nodeRegistryContract!.removeNodeSelf(ethersOverrides))
    }

    async addStreamToStorageNode(streamIdOrPath: string, nodeAddress: EthereumAddress): Promise<void> {
        const streamId = await this.streamIdBuilder.toStreamID(streamIdOrPath)
        log('Adding stream %s to node %s', streamId, nodeAddress)
        await this.connectToNodeRegistryContract()
        const ethersOverrides = this.ethereum.getStreamRegistryOverrides()
        await waitForTx(this.streamStorageRegistryContract!.addStorageNode(streamId, nodeAddress, ethersOverrides))
    }

    async removeStreamFromStorageNode(streamIdOrPath: string, nodeAddress: EthereumAddress): Promise<void> {
        const streamId = await this.streamIdBuilder.toStreamID(streamIdOrPath)
        log('Removing stream %s from node %s', streamId, nodeAddress)
        await this.connectToNodeRegistryContract()
        const ethersOverrides = this.ethereum.getStreamRegistryOverrides()
        await waitForTx(this.streamStorageRegistryContract!.removeStorageNode(streamId, nodeAddress, ethersOverrides))
    }

    // --------------------------------------------------------------------------------------------
    // GraphQL queries
    // --------------------------------------------------------------------------------------------

    /** @internal */
    async getStorageNodeUrl(nodeAddress: EthereumAddress): Promise<string> {
        log('getnode %s ', nodeAddress)
        const res = await this.graphQLClient.sendQuery(StorageNodeRegistry.buildGetNodeQuery(nodeAddress.toLowerCase())) as SingleNodeQueryResult
        if (res.node === null) {
            throw new NotFoundError('Node not found, id: ' + nodeAddress)
        }
        const metadata = JSON.parse(res.node.metadata)
        return metadata.http
    }

    async isStoredStream(streamIdOrPath: string, nodeAddress: EthereumAddress): Promise<boolean> {
        const streamId = await this.streamIdBuilder.toStreamID(streamIdOrPath)
        log('Checking if stream %s is stored in storage node %s', streamId, nodeAddress)
        return this.streamStorageRegistryContractReadonly.isStorageNodeOf(streamId, nodeAddress.toLowerCase())
    }

    async getStoredStreams(nodeAddress: EthereumAddress): Promise<{ streams: Stream[], blockNumber: number }> {
        log('Getting stored streams of node %s', nodeAddress)
        const res = await this.graphQLClient.sendQuery(StorageNodeRegistry.buildStorageNodeQuery(nodeAddress.toLowerCase())) as StorageNodeQueryResult
        const streams = res.node.storedStreams.map((stream) => {
            const props: StreamProperties = Stream.parsePropertiesFromMetadata(stream.metadata)
            return new Stream({ ...props, id: toStreamID(stream.id) }, this.container) // toStreamID() not strictly necessary
        })
        return {
            streams,
            // eslint-disable-next-line no-underscore-dangle
            blockNumber: res._meta.block.number
        }
    }

    async getStorageNodes(streamIdOrPath?: string): Promise<EthereumAddress[]> {
        if (streamIdOrPath !== undefined) {
            const streamId = await this.streamIdBuilder.toStreamID(streamIdOrPath)
            log('Getting storage nodes of stream %s', streamId)
            const res = await this.graphQLClient.sendQuery(StorageNodeRegistry.buildStoredStreamQuery(streamId)) as StoredStreamQueryResult
            if (res.stream === null) {
                return []
            }
            return res.stream.storageNodes.map((node) => node.id)
            // eslint-disable-next-line no-else-return
        } else {
            log('Getting all storage nodes')
            const res = await this.graphQLClient.sendQuery(StorageNodeRegistry.buildAllNodesQuery()) as AllNodesQueryResult
            return res.nodes.map((node) => node.id)
        }
    }

    async stop() {
        if (this.nodeRegistryContract) {
            this.nodeRegistryContract.removeAllListeners()
            this.nodeRegistryContract.provider.removeAllListeners()
        }
    }

    // --------------------------------------------------------------------------------------------
    // GraphQL queries
    // --------------------------------------------------------------------------------------------

    private static buildAllNodesQuery(): string {
        const query = `{
            nodes {
                id,
                metadata,
                lastSeen
            }
        }`
        return JSON.stringify({ query })
    }

    private static buildGetNodeQuery(nodeAddress: EthereumAddress): string {
        const query = `{
            node (id: "${nodeAddress}") {
                id,
                metadata,
                lastSeen
            }
        }`
        return JSON.stringify({ query })
    }

    private static buildStoredStreamQuery(streamId: StreamID): string {
        const query = `{
            stream (id: "${streamId}") {
                id,
                metadata,
                storageNodes {
                    id,
                    metadata,
                    lastSeen,
                }
            }
        }`
        return JSON.stringify({ query })
    }

    private static buildStorageNodeQuery(nodeAddress: EthereumAddress): string {
        const query = `{
            node (id: "${nodeAddress}") {
                id,
                metadata,
                lastSeen,
                storedStreams (first:1000) {
                    id,
                    metadata,
                }
            }
            _meta {
                block {
                    number
                }
            }
        }`
        return JSON.stringify({ query })
    }
}
