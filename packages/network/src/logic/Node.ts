import { EventEmitter } from 'events'
import {
    StreamPartID,
    StreamMessage,
    ProxyDirection, Receipt
} from 'streamr-client-protocol'
import { NodeToNode, Event as NodeToNodeEvent } from '../protocol/NodeToNode'
import { NodeToTracker } from '../protocol/NodeToTracker'
import { Metric, MetricsContext, MetricsDefinition, RateMetric } from '../helpers/Metric'
import { StreamPartManager } from './StreamPartManager'
import { GapMisMatchError, InvalidNumberingError } from './DuplicateMessageDetector'
import { Logger, withTimeout } from "@streamr/utils"
import { PeerInfo } from '../connection/PeerInfo'
import type { NodeId, TrackerId } from '../identifiers'
import { DEFAULT_MAX_NEIGHBOR_COUNT } from '../constants'
import { TrackerManager, TrackerManagerOptions } from './TrackerManager'
import { Propagation } from './propagation/Propagation'
import { DisconnectionManager } from './DisconnectionManager'
import { ProxyStreamConnectionManager } from './ProxyStreamConnectionManager'
import { ReceiptResponder } from './receipts/ReceiptResponder'
import { ReceiptRequester } from './receipts/ReceiptRequester'
import { Signers } from './receipts/SignatureFunctions'
import { ReceiptStore } from './receipts/ReceiptStore'
import { attachInspectResponder } from './receipts/attachInspectResponder'

export enum Event {
    NODE_CONNECTED = 'streamr:node:node-connected',
    NODE_DISCONNECTED = 'streamr:node:node-disconnected',
    MESSAGE_RECEIVED = 'streamr:node:message-received',
    UNSEEN_MESSAGE_RECEIVED = 'streamr:node:unseen-message-received',
    DUPLICATE_MESSAGE_RECEIVED = 'streamr:node:duplicate-message-received',
    NODE_SUBSCRIBED = 'streamr:node:subscribed-successfully',
    NODE_UNSUBSCRIBED = 'streamr:node:node-unsubscribed',
    PROXY_CONNECTION_ACCEPTED = 'streamr:node:proxy-connection-accepted',
    PROXY_CONNECTION_REJECTED = 'streamr:node:proxy-connection-rejected',
    ONE_WAY_CONNECTION_CLOSED = 'stream:node-one-way-connection-closed',
    JOIN_COMPLETED = 'stream:node-stream-join-operation-completed',
    JOIN_FAILED = 'stream:node-stream-join-operation-failed'
}

export interface NodeOptions extends TrackerManagerOptions {
    protocols: {
        nodeToNode: NodeToNode
        nodeToTracker: NodeToTracker
    }
    peerInfo: PeerInfo
    signers?: Signers
    metricsContext?: MetricsContext
    bufferTimeoutInMs?: number
    bufferMaxSize?: number
    disconnectionWaitTime?: number
    nodeConnectTimeout?: number
    acceptProxyConnections?: boolean
}

interface Metrics extends MetricsDefinition {
    publishMessagesPerSecond: Metric
    publishBytesPerSecond: Metric
}

export interface Node {
    on(event: Event.NODE_CONNECTED, listener: (nodeId: NodeId) => void): this
    on(event: Event.NODE_DISCONNECTED, listener: (nodeId: NodeId) => void): this
    on<T>(event: Event.MESSAGE_RECEIVED, listener: (msg: StreamMessage<T>, nodeId: NodeId) => void): this
    on<T>(event: Event.UNSEEN_MESSAGE_RECEIVED, listener: (msg: StreamMessage<T>, nodeId: NodeId) => void): this
    on<T>(event: Event.DUPLICATE_MESSAGE_RECEIVED, listener: (msg: StreamMessage<T>, nodeId: NodeId) => void): this
    on(event: Event.NODE_SUBSCRIBED, listener: (nodeId: NodeId, streamPartId: StreamPartID) => void): this
    on(event: Event.NODE_UNSUBSCRIBED, listener: (nodeId: NodeId, streamPartId: StreamPartID) => void): this
    on(event: Event.PROXY_CONNECTION_ACCEPTED, listener: (nodeId: NodeId, streamPartId: StreamPartID, direction: ProxyDirection) => void): this
    on(event: Event.PROXY_CONNECTION_REJECTED,
       listener: (nodeId: NodeId, streamPartId: StreamPartID, direction: ProxyDirection, reason?: string) => void): this
    on(event: Event.ONE_WAY_CONNECTION_CLOSED, listener: (nodeId: NodeId, streamPartId: StreamPartID) => void): this
    on(event: Event.JOIN_COMPLETED, listener: (streamPartId: StreamPartID, numOfNeighbors: number) => void): this
    on(event: Event.JOIN_FAILED, listener: (streamPartId: StreamPartID, error: string) => void): this
}

const logger = new Logger(module)

export class Node extends EventEmitter {
    public readonly peerInfo: PeerInfo
    protected readonly nodeToNode: NodeToNode
    private readonly nodeToTracker: NodeToTracker
    private readonly nodeConnectTimeout: number
    private readonly started: string

    protected readonly streamPartManager: StreamPartManager
    private readonly disconnectionManager: DisconnectionManager
    private readonly propagation: Propagation
    private readonly trackerManager: TrackerManager
    private readonly consecutiveDeliveryFailures: Record<NodeId, number> // id => counter
    private readonly metricsContext: MetricsContext
    private readonly metrics: Metrics
    protected extraMetadata: Record<string, unknown> = {}
    private readonly acceptProxyConnections: boolean
    private readonly proxyStreamConnectionManager: ProxyStreamConnectionManager
    private readonly receiptStore?: ReceiptStore
    private readonly receiptRequester?: ReceiptRequester
    private readonly receiptResponder?: ReceiptResponder

    constructor(opts: NodeOptions) {
        super()

        this.nodeToNode = opts.protocols.nodeToNode
        this.nodeToTracker = opts.protocols.nodeToTracker
        this.peerInfo = opts.peerInfo
        this.nodeConnectTimeout = opts.nodeConnectTimeout || 15000
        this.consecutiveDeliveryFailures = {}
        this.started = new Date().toLocaleString()
        this.acceptProxyConnections = opts.acceptProxyConnections || false

        this.metricsContext = opts.metricsContext || new MetricsContext()
        this.metrics = {
            publishMessagesPerSecond: new RateMetric(),
            publishBytesPerSecond: new RateMetric(),
        }
        this.metricsContext.addMetrics('node', this.metrics)

        if (opts.signers !== undefined) {
            this.receiptStore = new ReceiptStore(this.peerInfo.peerId)
            this.receiptRequester = new ReceiptRequester({
                myNodeId: this.peerInfo.peerId,
                nodeToNode: this.nodeToNode,
                receiptStore: this.receiptStore,
                signers: opts.signers
            })
            this.receiptResponder = new ReceiptResponder({
                myNodeId: this.peerInfo.peerId,
                nodeToNode: this.nodeToNode,
                receiptStore: this.receiptStore,
                signers: opts.signers
            })
            attachInspectResponder({
                myPeerInfo: this.peerInfo,
                receiptStore: this.receiptStore,
                nodeToTracker: this.nodeToTracker
            })
        }

        this.streamPartManager = new StreamPartManager()
        this.disconnectionManager = new DisconnectionManager({
            getAllNodes: this.nodeToNode.getAllConnectionNodeIds,
            hasSharedStreamParts: this.streamPartManager.isNodePresent.bind(this.streamPartManager),
            disconnect: this.nodeToNode.disconnectFromNode.bind(this.nodeToNode),
            disconnectionDelayInMs: opts.disconnectionWaitTime ?? 30 * 1000,
            cleanUpIntervalInMs: 2 * 60 * 1000
        })
        this.propagation = new Propagation({
            getNeighbors: this.streamPartManager.getOutboundNodesForStreamPart.bind(this.streamPartManager),
            sendToNeighbor: async (neighborId: NodeId, streamMessage: StreamMessage) => {
                try {
                    await this.nodeToNode.sendData(neighborId, streamMessage)
                    this.consecutiveDeliveryFailures[neighborId] = 0
                } catch (e) {
                    const serializedMsgId = streamMessage.getMessageID().serialize()
                    logger.warn('failed to propagate %s (consecutiveFails=%d) to subscriber %s, reason: %s',
                        serializedMsgId,
                        this.consecutiveDeliveryFailures[neighborId] || 0,
                        neighborId,
                        e)

                    // TODO: this is hack to get around the issue where `StreamStateManager` believes that we are
                    //  connected to a neighbor whilst `WebRtcEndpoint` knows that we are not. In this situation, the
                    //  Node will continuously attempt to propagate messages to the neighbor but will not actually ever
                    //  (re-)attempt a connection unless as a side-effect of something else (e.g. subscribing to another
                    //  stream, and the neighbor in question happens to get assigned to us via the other stream.)
                    //
                    // This hack basically counts consecutive delivery failures, and upon hitting 100 such failures,
                    // decides to forcefully disconnect the neighbor.
                    //
                    // Ideally this hack would not be needed, but alas, it seems like with the current event-system,
                    // we don't end up with an up-to-date state in the logic layer. I believe something like the
                    // ConnectionManager-model could help us solve the issue for good.
                    if (this.consecutiveDeliveryFailures[neighborId] === undefined) {
                        this.consecutiveDeliveryFailures[neighborId] = 0
                    }
                    this.consecutiveDeliveryFailures[neighborId] += 1
                    if (this.consecutiveDeliveryFailures[neighborId] >= 100) {
                        logger.warn(`disconnecting from ${neighborId} due to 100 consecutive delivery failures`)
                        this.onNodeDisconnected(neighborId) // force disconnect
                        this.consecutiveDeliveryFailures[neighborId] = 0
                    }
                    throw e
                }
            },
            minPropagationTargets: Math.floor(DEFAULT_MAX_NEIGHBOR_COUNT / 2)
        })
        this.trackerManager = new TrackerManager(
            this.nodeToTracker,
            opts,
            this.streamPartManager,
            (includeRtt) => ({
                started: this.started,
                location: this.peerInfo.location,
                extra: this.extraMetadata,
                rtts: includeRtt ? this.nodeToNode.getRtts() : null,
                version: "brubeck-1.0"
            }),
            {
                subscribeToStreamPartIfHaveNotYet: this.subscribeToStreamIfHaveNotYet.bind(this),
                subscribeToStreamPartOnNodes: this.subscribeToStreamPartOnNodes.bind(this),
                unsubscribeFromStreamPartOnNode: this.unsubscribeFromStreamPartOnNode.bind(this),
                emitJoinCompleted: this.emitJoinCompleted.bind(this),
                emitJoinFailed: this.emitJoinFailed.bind(this)

            }
        )
        this.proxyStreamConnectionManager = new ProxyStreamConnectionManager({
            trackerManager: this.trackerManager,
            streamPartManager: this.streamPartManager,
            propagation: this.propagation,
            node: this,
            nodeToNode: this.nodeToNode,
            acceptProxyConnections: this.acceptProxyConnections,
            nodeConnectTimeout: this.nodeConnectTimeout
        })

        this.nodeToNode.on(NodeToNodeEvent.NODE_CONNECTED, (nodeId) => this.emit(Event.NODE_CONNECTED, nodeId))
        this.nodeToNode.on(NodeToNodeEvent.DATA_RECEIVED, (broadcastMessage, nodeId) => this.onDataReceived(broadcastMessage.streamMessage, nodeId))
        this.nodeToNode.on(NodeToNodeEvent.NODE_DISCONNECTED, (nodeId) => this.onNodeDisconnected(nodeId))
        this.nodeToNode.on(NodeToNodeEvent.PROXY_CONNECTION_REQUEST_RECEIVED, (message,  nodeId) => {
            this.proxyStreamConnectionManager.processProxyConnectionRequest(message, nodeId)
        })
        this.nodeToNode.on(NodeToNodeEvent.PROXY_CONNECTION_RESPONSE_RECEIVED, (message, nodeId) => {
            this.proxyStreamConnectionManager.processProxyConnectionResponse(message, nodeId)
        })

        this.nodeToNode.on(NodeToNodeEvent.LEAVE_REQUEST_RECEIVED, (message, nodeId) => {
            this.proxyStreamConnectionManager.processLeaveRequest(message, nodeId)
        })
    }

    start(): void {
        logger.trace('started')
        this.trackerManager.start()
    }

    subscribeToStreamIfHaveNotYet(streamPartId: StreamPartID, sendStatus = true): void {
        if (!this.streamPartManager.isSetUp(streamPartId)) {
            logger.trace('add %s to streams', streamPartId)
            this.streamPartManager.setUpStreamPart(streamPartId)
            this.trackerManager.onNewStreamPart(streamPartId) // TODO: perhaps we should react based on event from StreamManager?
            if (sendStatus) {
                this.trackerManager.sendStreamPartStatus(streamPartId)
            }
        } else if (this.streamPartManager.isSetUp(streamPartId) && this.streamPartManager.isBehindProxy(streamPartId)) {
            logger.trace(`Could not join stream ${streamPartId} as stream is set to be behind proxy`)
        }
    }

    unsubscribeFromStream(streamPartId: StreamPartID, sendStatus = true): void {
        logger.trace('remove %s from streams', streamPartId)
        this.streamPartManager.removeStreamPart(streamPartId)
        this.trackerManager.onUnsubscribeFromStreamPart(streamPartId)
        if (sendStatus) {
            this.trackerManager.sendStreamPartStatus(streamPartId)
        }
    }

    subscribeToStreamPartOnNodes(
        nodeIds: NodeId[],
        streamPartId: StreamPartID,
        trackerId: TrackerId,
        reattempt: boolean
    ): Promise<PromiseSettledResult<NodeId>[]> {
        const subscribePromises = nodeIds.map(async (nodeId) => {
            await withTimeout(this.nodeToNode.connectToNode(nodeId, trackerId, !reattempt), this.nodeConnectTimeout)
            this.disconnectionManager.cancelScheduledDisconnection(nodeId)
            this.subscribeToStreamPartOnNode(nodeId, streamPartId, false)
            return nodeId
        })
        return Promise.allSettled(subscribePromises)
    }

    async addProxyConnection(streamPartId: StreamPartID, contactNodeId: string, direction: ProxyDirection): Promise<void> {
        let resolveHandler: any
        let rejectHandler: any
        await Promise.all([
            new Promise<void>((resolve, reject) => {
                resolveHandler = (node: string, stream: StreamPartID, eventDirection: ProxyDirection) => {
                    if (node === contactNodeId && stream === streamPartId && direction === eventDirection) {
                        resolve()
                    }
                }
                rejectHandler = (node: string, stream: StreamPartID, eventDirection: ProxyDirection, reason?: string) => {
                    if (node === contactNodeId && stream === streamPartId && direction === eventDirection) {
                        reject(new Error(
                            `Joining stream as proxy ${direction} failed on contact-node ${contactNodeId} for stream ${streamPartId}`
                            + ` reason: ${reason}`
                        ))
                    }
                }
                this.on(Event.PROXY_CONNECTION_ACCEPTED, resolveHandler)
                this.on(Event.PROXY_CONNECTION_REJECTED, rejectHandler)
            }),
            this.proxyStreamConnectionManager.openProxyConnection(streamPartId, contactNodeId, direction)
        ]).finally(() => {
            this.off(Event.PROXY_CONNECTION_ACCEPTED, resolveHandler)
            this.off(Event.PROXY_CONNECTION_REJECTED, rejectHandler)
        })
    }

    async removeProxyConnection(streamPartId: StreamPartID, contactNodeId: string, direction: ProxyDirection): Promise<void> {
        await this.proxyStreamConnectionManager.closeProxyConnection(streamPartId, contactNodeId, direction)
    }

    // Null source is used when a message is published by the node itself
    onDataReceived(streamMessage: StreamMessage, source: NodeId | null = null): void | never {
        const streamPartId = streamMessage.getStreamPartID()
        // Check if the stream is set as one-directional and has inbound connection
        if (source
            && this.streamPartManager.isSetUp(streamPartId)
            && this.streamPartManager.isBehindProxy(streamPartId)
            && !this.streamPartManager.hasInboundConnection(streamPartId, source)) {
            logger.warn(`Unexpected message received on outbound proxy stream from node ${source} on stream ${streamPartId}`)
            // Perhaps the node should be disconnected here if bad behaviour is repeated
            return
        }

        this.emit(Event.MESSAGE_RECEIVED, streamMessage, source)
        this.subscribeToStreamIfHaveNotYet(streamPartId)

        // Check duplicate
        let isUnseen
        try {
            isUnseen = this.streamPartManager.markNumbersAndCheckThatIsNotDuplicate(
                streamMessage.messageId,
                streamMessage.prevMsgRef
            )
        } catch (e) {
            if (e instanceof InvalidNumberingError) {
                logger.trace('received from %s data %j with invalid numbering', source, streamMessage.messageId)
                return
            }
            if (e instanceof GapMisMatchError) {
                logger.warn('received from %s data %j with gap mismatch detected: %j',
                    source, streamMessage.messageId, e)
                return
            }
            throw e
        }

        if (isUnseen) {
            logger.trace('received from %s data %j', source, streamMessage.messageId)
            this.emit(Event.UNSEEN_MESSAGE_RECEIVED, streamMessage, source)
            this.propagation.feedUnseenMessage(streamMessage, source)
            if (source === null) {
                this.metrics.publishMessagesPerSecond.record(1)
                this.metrics.publishBytesPerSecond.record(streamMessage.getSerializedContent().length)
            }
        } else {
            logger.trace('ignoring duplicate data %j (from %s)', streamMessage.messageId, source)
            this.emit(Event.DUPLICATE_MESSAGE_RECEIVED, streamMessage, source)
        }
    }

    stop(): Promise<unknown> {
        this.proxyStreamConnectionManager.stop()
        this.disconnectionManager.stop()
        this.receiptRequester?.stop()
        this.nodeToNode.stop()
        return this.trackerManager.stop()
    }

    protected inspect(nodeId: NodeId, inspectionTarget: NodeId): Promise<Receipt[]> {
        // eslint-disable-next-line no-async-promise-executor
        return withTimeout(new Promise(async (resolve) => {
            const sharedTrackerId = 'gdsgd'
            const requestId = await this.nodeToTracker.sendInspectRequestMessage(sharedTrackerId, nodeId, this.peerInfo, inspectionTarget)
            const results = new Array<Receipt>()
            this.nodeToTracker.registerRelayMessageHandler(requestId, (relayMessage, _source) => {
                // TODO: check source?
                if (relayMessage.isInspectResponsePartMessage()) {
                    if (relayMessage.data.done) {
                        resolve(results)
                        return true
                    } else {
                        results.push(relayMessage.data.receipt)
                    }
                }
                return false
            })
        }), 60 * 1000, 'sdgasdg')
    }

    private subscribeToStreamPartOnNode(node: NodeId, streamPartId: StreamPartID, sendStatus = true): NodeId {
        this.streamPartManager.addNeighbor(streamPartId, node)
        this.propagation.onNeighborJoined(node, streamPartId)
        if (sendStatus) {
            this.trackerManager.sendStreamPartStatus(streamPartId)
        }
        this.emit(Event.NODE_SUBSCRIBED, node, streamPartId)
        return node
    }

    private unsubscribeFromStreamPartOnNode(node: NodeId, streamPartId: StreamPartID, sendStatus = true): void {
        this.streamPartManager.removeNodeFromStreamPart(streamPartId, node)
        logger.trace('node %s unsubscribed from stream %s', node, streamPartId)
        this.emit(Event.NODE_UNSUBSCRIBED, node, streamPartId)
        this.disconnectionManager.scheduleDisconnectionIfNoSharedStreamParts(node)
        if (sendStatus) {
            this.trackerManager.sendStreamPartStatus(streamPartId)
        }
    }

    private onNodeDisconnected(node: NodeId): void {
        const [streams, proxiedStreams] = this.streamPartManager.removeNodeFromAllStreamParts(node)
        logger.trace('removed all subscriptions of node %s', node)
        streams.forEach((s) => {
            this.trackerManager.sendStreamPartStatus(s)
        })
        proxiedStreams.forEach((s) => {
            this.proxyStreamConnectionManager.reconnect(node, s)
        })
        this.emit(Event.NODE_DISCONNECTED, node)
    }

    getStreamParts(): Iterable<StreamPartID> {
        return this.streamPartManager.getStreamParts()
    }

    getNeighbors(): ReadonlyArray<NodeId> {
        return this.streamPartManager.getAllNodes()
    }

    getNodeId(): NodeId {
        return this.peerInfo.peerId
    }

    getMetricsContext(): MetricsContext {
        return this.metricsContext
    }

    async subscribeAndWaitForJoinOperation(streamPartId: StreamPartID, timeout = this.nodeConnectTimeout): Promise<number> {
        if (this.streamPartManager.isSetUp(streamPartId)) {
            return this.streamPartManager.getAllNodesForStreamPart(streamPartId).length
        }
        let resolveHandler: any
        let rejectHandler: any
        const res = await Promise.all([
            withTimeout(new Promise<number>((resolve, reject) => {
                resolveHandler = (stream: StreamPartID, numOfNeighbors: number) => {
                    if (stream === streamPartId) {
                        resolve(numOfNeighbors)
                    }
                }
                rejectHandler = (stream: StreamPartID, error: string) => {
                    if (stream === streamPartId) {
                        reject(new Error(error))
                    }
                }
                this.on(Event.JOIN_COMPLETED, resolveHandler)
                this.on(Event.JOIN_FAILED, rejectHandler)
            }), timeout),
            this.subscribeToStreamIfHaveNotYet(streamPartId)
        ]).finally(() => {
            this.off(Event.JOIN_COMPLETED, resolveHandler)
            this.off(Event.JOIN_FAILED, rejectHandler)
        })
        return res[0]
    }

    emitJoinCompleted(streamPartId: StreamPartID, numOfNeighbors: number): void {
        this.emit(Event.JOIN_COMPLETED, streamPartId, numOfNeighbors)
    }

    emitJoinFailed(streamPartId: StreamPartID, error: string): void {
        this.emit(streamPartId, error)
    }

    isProxiedStreamPart(streamPartId: StreamPartID, direction: ProxyDirection): boolean {
        return this.proxyStreamConnectionManager.isProxiedStreamPart(streamPartId, direction)
    }
}
