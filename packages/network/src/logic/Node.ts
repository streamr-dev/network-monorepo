import { EventEmitter } from 'events'
import { StreamMessage, InstructionMessage, TrackerRegistry, createTrackerRegistry } from 'streamr-client-protocol'
import { NodeToNode, Event as NodeToNodeEvent } from '../protocol/NodeToNode'
import { NodeToTracker, Event as NodeToTrackerEvent } from '../protocol/NodeToTracker'
import { MessageBuffer } from '../helpers/MessageBuffer'
import { SeenButNotPropagatedSet } from '../helpers/SeenButNotPropagatedSet'
import { Status, StreamIdAndPartition, TrackerRecord } from '../identifiers'
import { Metrics, MetricsContext } from '../helpers/MetricsContext'
import { promiseTimeout } from '../helpers/PromiseTools'
import { StreamManager } from './StreamManager'
import { InstructionThrottler } from './InstructionThrottler'
import { GapMisMatchError, InvalidNumberingError } from './DuplicateMessageDetector'
import { Logger } from '../helpers/Logger'
import { PeerInfo } from '../connection/PeerInfo'
import { InstructionRetryManager } from "./InstructionRetryManager"
import { NameDirectory } from '../NameDirectory'
import { DisconnectionReason } from "../connection/ws/AbstractWsEndpoint"
import { TrackerId } from './Tracker'
import { TrackerConnector } from './TrackerConnector'

export type NodeId = string

export enum Event {
    NODE_CONNECTED = 'streamr:node:node-connected',
    NODE_DISCONNECTED = 'streamr:node:node-disconnected',
    MESSAGE_RECEIVED = 'streamr:node:message-received',
    UNSEEN_MESSAGE_RECEIVED = 'streamr:node:unseen-message-received',
    MESSAGE_PROPAGATED = 'streamr:node:message-propagated',
    MESSAGE_PROPAGATION_FAILED = 'streamr:node:message-propagation-failed',
    NODE_SUBSCRIBED = 'streamr:node:subscribed-successfully',
    NODE_UNSUBSCRIBED = 'streamr:node:node-unsubscribed'
}

export interface NodeOptions {
    protocols: {
        nodeToNode: NodeToNode
        nodeToTracker: NodeToTracker
    }
    peerInfo: PeerInfo
    trackers: TrackerRecord[]
    metricsContext?: MetricsContext
    bufferTimeoutInMs?: number
    bufferMaxSize?: number
    disconnectionWaitTime?: number
    nodeConnectTimeout?: number
    instructionRetryInterval?: number
    rttUpdateTimeout?: number
    trackerConnectionMaintenanceInterval?: number
}

const MIN_NUM_OF_OUTBOUND_NODES_FOR_PROPAGATION = 1

export interface Node {
    on(event: Event.NODE_CONNECTED, listener: (nodeId: NodeId) => void): this
    on(event: Event.NODE_DISCONNECTED, listener: (nodeId: NodeId) => void): this
    on(event: Event.MESSAGE_RECEIVED, listener: (msg: StreamMessage, nodeId: NodeId) => void): this
    on(event: Event.UNSEEN_MESSAGE_RECEIVED, listener: (msg: StreamMessage, nodeId: NodeId) => void): this
    on(event: Event.MESSAGE_PROPAGATED, listener: (msg: StreamMessage) => void): this
    on(event: Event.MESSAGE_PROPAGATION_FAILED, listener: (msg: StreamMessage, nodeId: NodeId, error: Error) => void): this
    on(event: Event.NODE_SUBSCRIBED, listener: (nodeId: NodeId, streamId: StreamIdAndPartition) => void): this
    on(event: Event.NODE_UNSUBSCRIBED, listener: (nodeId: NodeId, streamId: StreamIdAndPartition) => void): this
}

export class Node extends EventEmitter {
    protected readonly nodeToNode: NodeToNode
    private readonly nodeToTracker: NodeToTracker
    private readonly peerInfo: PeerInfo
    private readonly bufferTimeoutInMs: number
    private readonly bufferMaxSize: number
    private readonly disconnectionWaitTime: number
    private readonly nodeConnectTimeout: number
    private readonly instructionRetryInterval: number
    private readonly rttUpdateInterval: number
    private readonly started: string

    private readonly logger: Logger
    private readonly disconnectionTimers: Record<NodeId,NodeJS.Timeout>
    protected readonly streams: StreamManager
    private readonly messageBuffer: MessageBuffer<[StreamMessage, string | null]>
    private readonly seenButNotPropagatedSet: SeenButNotPropagatedSet
    private readonly trackerRegistry: TrackerRegistry
    private readonly trackerBook: { [key: string]: TrackerId } // address => id
    private readonly trackerConnector: TrackerConnector
    private readonly instructionThrottler: InstructionThrottler
    private readonly instructionRetryManager: InstructionRetryManager
    private readonly consecutiveDeliveryFailures: Record<NodeId,number> // id => counter
    private readonly rttUpdateTimeoutsOnTrackers: { [key: string]: NodeJS.Timeout } // trackerId => timeout
    private readonly metrics: Metrics
    private connectionCleanUpInterval: NodeJS.Timeout | null
    private handleBufferedMessagesTimeoutRef?: NodeJS.Timeout | null
    protected extraMetadata: Record<string, unknown> = {}

    constructor(opts: NodeOptions) {
        super()

        if (!(opts.protocols.nodeToTracker instanceof NodeToTracker) || !(opts.protocols.nodeToNode instanceof NodeToNode)) {
            throw new Error('Provided protocols are not correct')
        }
        if (!opts.trackers) {
            throw new Error('No trackers given')
        }

        this.nodeToNode = opts.protocols.nodeToNode
        this.nodeToTracker = opts.protocols.nodeToTracker
        this.peerInfo = opts.peerInfo

        this.bufferTimeoutInMs = opts.bufferTimeoutInMs || 60 * 1000
        this.bufferMaxSize = opts.bufferMaxSize || 10000
        this.disconnectionWaitTime = opts.disconnectionWaitTime || 30 * 1000
        this.nodeConnectTimeout = opts.nodeConnectTimeout || 15000
        this.instructionRetryInterval = opts.instructionRetryInterval || 3 * 60 * 1000
        this.rttUpdateInterval = opts.rttUpdateTimeout || 15000
        this.started = new Date().toLocaleString()
        this.logger = new Logger(module)

        const metricsContext = opts.metricsContext || new MetricsContext('')

        this.disconnectionTimers = {}
        this.streams = new StreamManager()
        this.messageBuffer = new MessageBuffer(this.bufferTimeoutInMs, this.bufferMaxSize, (streamId) => {
            this.logger.trace(`failed to deliver buffered messages of stream ${streamId}`)
        })
        this.seenButNotPropagatedSet = new SeenButNotPropagatedSet()

        this.trackerRegistry = createTrackerRegistry(opts.trackers)
        this.trackerBook = {}
        this.rttUpdateTimeoutsOnTrackers = {}
        this.instructionThrottler = new InstructionThrottler(this.handleTrackerInstruction.bind(this))
        this.instructionRetryManager = new InstructionRetryManager(
            this.handleTrackerInstruction.bind(this),
            this.instructionRetryInterval
        )
        this.consecutiveDeliveryFailures = {}
        this.trackerConnector = new TrackerConnector(() => this.streams.getStreams(), this.nodeToTracker, this.trackerRegistry, this.logger, opts.trackerConnectionMaintenanceInterval ?? 5000)
        this.connectionCleanUpInterval = null

        this.nodeToTracker.on(NodeToTrackerEvent.CONNECTED_TO_TRACKER, (trackerId) => this.onConnectedToTracker(trackerId))
        this.nodeToTracker.on(NodeToTrackerEvent.TRACKER_INSTRUCTION_RECEIVED, (streamMessage, trackerId) => this.onTrackerInstructionReceived(trackerId, streamMessage))  // eslint-disable-line max-len
        this.nodeToTracker.on(NodeToTrackerEvent.TRACKER_DISCONNECTED, (trackerId) => this.onTrackerDisconnected(trackerId))
        this.nodeToNode.on(NodeToNodeEvent.NODE_CONNECTED, (nodeId) => this.emit(Event.NODE_CONNECTED, nodeId))
        this.nodeToNode.on(NodeToNodeEvent.DATA_RECEIVED, (broadcastMessage, nodeId) => this.onDataReceived(broadcastMessage.streamMessage, nodeId))
        this.nodeToNode.on(NodeToNodeEvent.NODE_DISCONNECTED, (nodeId) => this.onNodeDisconnected(nodeId))
        let avgLatency = -1

        this.on(Event.UNSEEN_MESSAGE_RECEIVED, (message) => {
            const now = new Date().getTime()
            const currentLatency = now - message.messageId.timestamp

            if (avgLatency < 0) {
                avgLatency = currentLatency
            } else {
                avgLatency = 0.8 * avgLatency + 0.2 * currentLatency
            }

            this.metrics.set('latency', avgLatency)
        })

        this.metrics = metricsContext.create('node')
            .addQueriedMetric('messageBufferSize', () => this.messageBuffer.size())
            .addQueriedMetric('seenButNotPropagatedSetSize', () => this.seenButNotPropagatedSet.size())
            .addRecordedMetric('unexpectedTrackerInstructions')
            .addRecordedMetric('trackerInstructions')
            .addRecordedMetric('onDataReceived')
            .addRecordedMetric('onDataReceived:invalidNumbering')
            .addRecordedMetric('onDataReceived:gapMismatch')
            .addRecordedMetric('onDataReceived:ignoredDuplicate')
            .addRecordedMetric('propagateMessage')
            .addRecordedMetric('onSubscribeRequest')
            .addRecordedMetric('onUnsubscribeRequest')
            .addRecordedMetric('onNodeDisconnect')
            .addFixedMetric('latency')
    }

    start(): void {
        this.logger.trace('started')
        this.trackerConnector.start()
        clearInterval(this.connectionCleanUpInterval!)
        this.connectionCleanUpInterval = this.startConnectionCleanUpInterval(2 * 60 * 1000)
    }

    onConnectedToTracker(tracker: TrackerId): void {
        this.logger.trace('connected to tracker %s', tracker)
        const serverUrl = this.nodeToTracker.getServerUrlByTrackerId(tracker)
        if (serverUrl !== undefined) {
            this.trackerBook[serverUrl] = tracker
            this.prepareAndSendMultipleStatuses(tracker)
        } else {
            this.logger.warn('onConnectedToTracker: unknown tracker %s', tracker)
        }
    }

    subscribeToStreamIfHaveNotYet(streamId: StreamIdAndPartition, sendStatus = true): void {
        if (!this.streams.isSetUp(streamId)) {
            this.logger.trace('add %s to streams', streamId)
            this.streams.setUpStream(streamId)
            this.trackerConnector.maintainConnections()
            if (sendStatus) {
                this.prepareAndSendStreamStatus(streamId)
            }
        }
    }

    unsubscribeFromStream(streamId: StreamIdAndPartition, sendStatus = true): void {
        this.logger.trace('remove %s from streams', streamId)
        this.streams.removeStream(streamId)
        this.instructionThrottler.removeStream(streamId.key())
        this.instructionRetryManager.removeStream(streamId.key())
        if (sendStatus) {
            this.prepareAndSendStreamStatus(streamId)
        }
    }

    onTrackerInstructionReceived(trackerId: TrackerId, instructionMessage: InstructionMessage): void {
        this.instructionThrottler.add(instructionMessage, trackerId)
    }

    async handleTrackerInstruction(instructionMessage: InstructionMessage, trackerId: TrackerId, reattempt = false): Promise<void> {
        const streamId = StreamIdAndPartition.fromMessage(instructionMessage)
        const { nodeIds, counter } = instructionMessage

        this.instructionRetryManager.add(instructionMessage, trackerId)

        // Check that tracker matches expected tracker
        const expectedTrackerId = this.getTrackerId(streamId)
        if (trackerId !== expectedTrackerId) {
            this.metrics.record('unexpectedTrackerInstructions', 1)
            this.logger.warn(`got instructions from unexpected tracker. Expected ${expectedTrackerId}, got from ${trackerId}`)
            return
        }

        this.metrics.record('trackerInstructions', 1)
        this.logger.trace('received instructions for %s, nodes to connect %o', streamId, nodeIds)

        this.subscribeToStreamIfHaveNotYet(streamId, false)
        const currentNodes = this.streams.getAllNodesForStream(streamId)
        const nodesToUnsubscribeFrom = currentNodes.filter((nodeId) => !nodeIds.includes(nodeId))

        const subscribePromises = nodeIds.map(async (nodeId) => {
            
            await promiseTimeout(this.nodeConnectTimeout, 
                this.nodeToNode.connectToNode(nodeId, trackerId, !reattempt))
            
            this.clearDisconnectionTimer(nodeId)
            this.subscribeToStreamOnNode(nodeId, streamId, false)
            return nodeId
        })

        nodesToUnsubscribeFrom.forEach((nodeId) => {
            this.unsubscribeFromStreamOnNode(nodeId, streamId, false)
        })

        const results = await Promise.allSettled(subscribePromises)
        if (this.streams.isSetUp(streamId)) {
            this.streams.updateCounter(streamId, counter)
        }

        // Log success / failures
        const subscribedNodeIds: NodeId[] = []
        const unsubscribedNodeIds: NodeId[] = []
        let failedInstructions = false
        results.forEach((res) => {
            if (res.status === 'fulfilled') {
                subscribedNodeIds.push(res.value)
            } else {
                failedInstructions = true
                this.logger.info('failed to subscribe (or connect) to node, reason: %s', res.reason)
            }
        })
        if (!reattempt || failedInstructions) {
            this.prepareAndSendStreamStatus(streamId)
        }

        this.logger.trace('subscribed to %j and unsubscribed from %j (streamId=%s, counter=%d)',
            subscribedNodeIds, unsubscribedNodeIds, streamId, counter)

        if (subscribedNodeIds.length !== nodeIds.length) {
            this.logger.trace('error: failed to fulfill all tracker instructions (streamId=%s, counter=%d)',
                streamId, counter)
        } else {
            this.logger.trace('Tracker instructions fulfilled (streamId=%s, counter=%d)',
                streamId, counter)
        }
    }

    onDataReceived(streamMessage: StreamMessage, source: NodeId | null = null): void | never {
        this.metrics.record('onDataReceived', 1)
        const streamIdAndPartition = new StreamIdAndPartition(
            streamMessage.getStreamId(),
            streamMessage.getStreamPartition()
        )

        this.emit(Event.MESSAGE_RECEIVED, streamMessage, source)

        this.subscribeToStreamIfHaveNotYet(streamIdAndPartition)

        // Check duplicate
        let isUnseen
        try {
            isUnseen = this.streams.markNumbersAndCheckThatIsNotDuplicate(
                streamMessage.messageId,
                streamMessage.prevMsgRef
            )
        } catch (e) {
            if (e instanceof InvalidNumberingError) {
                this.logger.trace('received from %s data %j with invalid numbering', source, streamMessage.messageId)
                this.metrics.record('onDataReceived:invalidNumber', 1)
                return
            }
            if (e instanceof GapMisMatchError) {
                this.logger.warn('received from %s data %j with gap mismatch detected: %j',
                    source, streamMessage.messageId, e)
                this.metrics.record('onDataReceived:gapMismatch', 1)
                return
            }
            throw e
        }

        if (isUnseen) {
            this.emit(Event.UNSEEN_MESSAGE_RECEIVED, streamMessage, source)
        }
        if (isUnseen || this.seenButNotPropagatedSet.has(streamMessage)) {
            this.logger.trace('received from %s data %j', source, streamMessage.messageId)
            this.propagateMessage(streamMessage, source)
        } else {
            this.logger.trace('ignoring duplicate data %j (from %s)', streamMessage.messageId, source)
            this.metrics.record('onDataReceived:ignoredDuplicate', 1)
        }
    }

    private propagateMessage(streamMessage: StreamMessage, source: NodeId | null): void {
        this.metrics.record('propagateMessage', 1)
        const streamIdAndPartition = new StreamIdAndPartition(
            streamMessage.getStreamId(),
            streamMessage.getStreamPartition()
        )
        const subscribers = this.streams.getOutboundNodesForStream(streamIdAndPartition).filter((n) => n !== source)

        if (!subscribers.length) {
            this.logger.debug('put back to buffer because could not propagate to %d nodes or more: %j',
                MIN_NUM_OF_OUTBOUND_NODES_FOR_PROPAGATION, streamMessage.messageId)
            this.logger.trace('streams: %j', this.streams)
            this.seenButNotPropagatedSet.add(streamMessage)
            this.messageBuffer.put(streamIdAndPartition.key(), [streamMessage, source])
            return
        }
        subscribers.forEach(async (subscriber) => {
            try {
                await this.nodeToNode.sendData(subscriber, streamMessage)
                this.consecutiveDeliveryFailures[subscriber] = 0
            } catch (e) {
                const serializedMsgId = streamMessage.getMessageID().serialize()
                this.logger.warn('failed to propagate %s (consecutiveFails=%d) to subscriber %s, reason: %s',
                    serializedMsgId,
                    this.consecutiveDeliveryFailures[subscriber] || 0,
                    subscriber,
                    e)
                this.emit(Event.MESSAGE_PROPAGATION_FAILED, streamMessage.getMessageID(), subscriber, e)

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
                if (this.consecutiveDeliveryFailures[subscriber] === undefined) {
                    this.consecutiveDeliveryFailures[subscriber] = 0
                }
                this.consecutiveDeliveryFailures[subscriber] += 1
                if (this.consecutiveDeliveryFailures[subscriber] >= 100) {
                    this.logger.warn(`disconnecting from ${subscriber} due to 100 consecutive delivery failures`)
                    this.onNodeDisconnected(subscriber) // force disconnect
                    this.consecutiveDeliveryFailures[subscriber] = 0
                }
            }
        })

        this.seenButNotPropagatedSet.delete(streamMessage)
        this.emit(Event.MESSAGE_PROPAGATED, streamMessage)
    }

    stop(): Promise<unknown> {
        this.logger.trace('stopping')
        
        this.instructionThrottler.stop()
        this.instructionRetryManager.stop()

        this.trackerConnector.stop()
        if (this.handleBufferedMessagesTimeoutRef) {
            clearTimeout(this.handleBufferedMessagesTimeoutRef)
            this.handleBufferedMessagesTimeoutRef = null
        }

        if (this.connectionCleanUpInterval) {
            clearInterval(this.connectionCleanUpInterval)
            this.connectionCleanUpInterval = null
        }

        Object.values(this.disconnectionTimers).forEach((timeout) => clearTimeout(timeout))
        Object.values(this.rttUpdateTimeoutsOnTrackers).forEach((timeout) => clearTimeout(timeout))

        this.messageBuffer.clear()
        return Promise.all([
            this.nodeToTracker.stop(),
            this.nodeToNode.stop(),
        ])
    }

    // Gets statuses of all streams assigned to a tracker by default
    private getMultipleStatusMessages(tracker: TrackerId, explicitStreams?: StreamIdAndPartition[]): Status[] {
        const streams = explicitStreams || this.streams.getStreams()
        const statusMessages = streams
            .filter((streamId) => this.getTrackerId(streamId) === tracker)
            .map((streamId) => this.getStreamStatus(streamId, tracker))
        return statusMessages
    }

    private getStreamStatus(streamId: StreamIdAndPartition, trackerId: TrackerId): Status {
        const rtts = this.checkRttTimeout(trackerId) ? this.nodeToNode.getRtts() : null
        return {
            streams: this.streams.getStreamState(streamId),
            started: this.started,
            rtts,
            location: this.peerInfo.location,
            singleStream: true,
            extra: this.extraMetadata
        }
    }

    private prepareAndSendStreamStatus(streamId: StreamIdAndPartition): void {
        const trackerId = this.getTrackerId(streamId)
        if (trackerId) {
            const status = this.getStreamStatus(streamId, trackerId)
            if (status) {
                this.sendStatus(trackerId, status)
            } else {
                this.logger.warn('failed to prepareAndSendStreamStatus %s to tracker %s, ' +
                    'reason: stream status not found', streamId, trackerId)
            }
        }
    }

    private prepareAndSendMultipleStatuses(tracker: TrackerId, streams?: StreamIdAndPartition[]): void {
        const statusMessages = this.getMultipleStatusMessages(tracker, streams)
        statusMessages.forEach((status) => {
            this.sendStatus(tracker, status)
        })
    }

    private async sendStatus(tracker: TrackerId, status: Status) {
        try {
            await this.nodeToTracker.sendStatus(tracker, status)
            this.logger.trace('sent status %j to tracker %s', status.streams, tracker)
        } catch (e) {
            this.logger.trace('failed to send status to tracker %s, reason: %s', tracker, e)
        }
    }

    private subscribeToStreamOnNode(node: NodeId, streamId: StreamIdAndPartition, sendStatus = true): NodeId {
        this.streams.addInboundNode(streamId, node)
        this.streams.addOutboundNode(streamId, node)
        this.handleBufferedMessages(streamId)
        if (sendStatus) {
            this.prepareAndSendStreamStatus(streamId)
        }
        this.emit(Event.NODE_SUBSCRIBED, node, streamId)
        return node
    }

    protected getTrackerId(streamId: StreamIdAndPartition): TrackerId | null {
        const { ws } = this.trackerRegistry.getTracker(streamId.id, streamId.partition)
        return this.trackerBook[ws] || null
    }

    protected isNodePresent(nodeId: NodeId): boolean {
        return this.streams.isNodePresent(nodeId)
    }

    private checkRttTimeout(trackerId: TrackerId): boolean {
        if (!(trackerId in this.rttUpdateTimeoutsOnTrackers)) {
            this.rttUpdateTimeoutsOnTrackers[trackerId] = setTimeout(() => {
                this.logger.trace(`RTT timeout to ${trackerId} triggered, RTTs to connections will be updated with the next status message`)
                delete this.rttUpdateTimeoutsOnTrackers[trackerId]
            }, this.rttUpdateInterval)
            return true
        }
        return false
    }

    private unsubscribeFromStreamOnNode(node: NodeId, streamId: StreamIdAndPartition, sendStatus = true): void {
        this.streams.removeNodeFromStream(streamId, node)
        this.logger.trace('node %s unsubscribed from stream %s', node, streamId)
        this.emit(Event.NODE_UNSUBSCRIBED, node, streamId)

        if (!this.streams.isNodePresent(node)) {
            this.clearDisconnectionTimer(node)
            this.disconnectionTimers[node] = setTimeout(() => {
                delete this.disconnectionTimers[node]
                if (!this.streams.isNodePresent(node)) {
                    this.logger.info('No shared streams with %s, disconnecting', NameDirectory.getName(node))
                    this.nodeToNode.disconnectFromNode(node, DisconnectionReason.NO_SHARED_STREAMS)
                }
            }, this.disconnectionWaitTime)
        }
        if (sendStatus) {
            this.prepareAndSendStreamStatus(streamId)
        }
    }

    onNodeDisconnected(node: NodeId): void {
        this.metrics.record('onNodeDisconnect', 1)
        const streams = this.streams.removeNodeFromAllStreams(node)
        this.logger.trace('removed all subscriptions of node %s', node)
        const trackers = [...new Set(streams.map((streamId) => this.getTrackerId(streamId)))]
        trackers.forEach((trackerId) => {
            if (trackerId) {
                this.prepareAndSendMultipleStatuses(trackerId, streams)
            }
        })
        this.emit(Event.NODE_DISCONNECTED, node)
    }

    onTrackerDisconnected(tracker: TrackerId): void {
        this.logger.trace('disconnected from tracker %s', tracker)
    }

    private handleBufferedMessages(streamId: StreamIdAndPartition): void {
        this.messageBuffer.popAll(streamId.key())
            .forEach(([streamMessage, source]) => {
                this.onDataReceived(streamMessage, source)
            })
    }

    private clearDisconnectionTimer(nodeId: NodeId): void {
        if (this.disconnectionTimers[nodeId] != null) {
            clearTimeout(this.disconnectionTimers[nodeId])
            delete this.disconnectionTimers[nodeId]
        }
    }

    private startConnectionCleanUpInterval(interval: number): NodeJS.Timeout {
        return setInterval(() => {
            const peerIds = this.nodeToNode.getAllConnectionNodeIds()
            const unusedConnections = peerIds.filter((peer) => !this.isNodePresent(peer))
            if (unusedConnections.length > 0) {
                this.logger.debug(`Disconnecting from ${unusedConnections.length} unused connections`)
                unusedConnections.forEach((peerId) => {
                    this.nodeToNode.disconnectFromNode(peerId, 'Unused connection')
                })
            }
        }, interval)
    }

    getStreams(): ReadonlyArray<string> {
        return this.streams.getStreamsAsKeys()
    }

    getNeighbors(): ReadonlyArray<NodeId> {
        return this.streams.getAllNodes()
    }
}
