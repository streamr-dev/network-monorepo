import { StreamPartID, TrackerLayer, Utils } from 'streamr-client-protocol'
import { Location, Rtts, TrackerInfo, NodeId, TrackerId } from '../identifiers'
import { TrackerConnector } from './TrackerConnector'
import { NodeToTracker, Event as NodeToTrackerEvent } from '../protocol/NodeToTracker'
import { StreamPartManager } from './StreamPartManager'
import { Logger } from '../helpers/Logger'
import { InstructionThrottler } from './InstructionThrottler'
import { InstructionRetryManager } from './InstructionRetryManager'
import { NameDirectory } from '../NameDirectory'

const logger = new Logger(module)

interface NodeDescriptor {
    started: string
    location?: Location
    extra: Record<string, unknown>
    rtts: Readonly<Rtts> | null
}

interface Subscriber {
    subscribeToStreamPartIfHaveNotYet: (streamPartId: StreamPartID, sendStatus?: boolean) => void
    subscribeToStreamPartOnNodes: (
        nodeIds: NodeId[],
        streamPartId: StreamPartID,
        trackerId: TrackerId,
        reattempt: boolean
    ) => Promise<PromiseSettledResult<NodeId>[]>,
    unsubscribeFromStreamPartOnNode: (node: NodeId, streamPartId: StreamPartID, sendStatus?: boolean) => void
    emitJoinCompleted: (streamPartId: StreamPartID, numOfNeighbors: number) => void
    emitJoinFailed: (streamPartId: StreamPartID, error: string) => void
}

type GetNodeDescriptor = (includeRtt: boolean) => NodeDescriptor

export interface TrackerManagerOptions {
    trackers: Array<TrackerInfo>
    rttUpdateTimeout?: number
    trackerConnectionMaintenanceInterval?: number
    instructionRetryInterval?: number
}

export class TrackerManager {
    private readonly rttUpdateTimeoutsOnTrackers: Record<TrackerId, NodeJS.Timeout> = {}
    private readonly trackerRegistry: Utils.TrackerRegistry<TrackerInfo>
    private readonly trackerConnector: TrackerConnector
    private readonly nodeToTracker: NodeToTracker
    private readonly streamPartManager: StreamPartManager
    private readonly rttUpdateInterval: number
    private readonly instructionThrottler: InstructionThrottler
    private readonly instructionRetryManager: InstructionRetryManager
    private readonly getNodeDescriptor: GetNodeDescriptor
    private readonly subscriber: Subscriber

    constructor(
        nodeToTracker: NodeToTracker,
        opts: TrackerManagerOptions,
        streamPartManager: StreamPartManager,
        getNodeDescriptor: GetNodeDescriptor,
        subscriber: Subscriber
    ) {
        this.nodeToTracker =  nodeToTracker
        this.streamPartManager = streamPartManager
        this.trackerRegistry = Utils.createTrackerRegistry<TrackerInfo>(opts.trackers)
        this.getNodeDescriptor = getNodeDescriptor
        this.subscriber = subscriber
        this.rttUpdateInterval = opts.rttUpdateTimeout || 15000
        this.trackerConnector = new TrackerConnector(
            streamPartManager.getStreamParts.bind(streamPartManager),
            this.nodeToTracker.connectToTracker.bind(this.nodeToTracker),
            this.nodeToTracker.disconnectFromTracker.bind(this.nodeToTracker),
            this.trackerRegistry,
            opts.trackerConnectionMaintenanceInterval ?? 5000
        )

        this.instructionThrottler = new InstructionThrottler(this.handleTrackerInstruction.bind(this))
        this.instructionRetryManager = new InstructionRetryManager(
            this.handleTrackerInstruction.bind(this),
            opts.instructionRetryInterval || 3 * 60 * 1000
        )

        this.nodeToTracker.on(NodeToTrackerEvent.CONNECTED_TO_TRACKER, (trackerId) => {
            logger.trace('connected to tracker %s', trackerId)
            this.getStreamPartsForTracker(trackerId).forEach((streamPart) => {
                this.sendStatus(streamPart, trackerId)
            })
        })
        this.nodeToTracker.on(NodeToTrackerEvent.STATUS_ACK_RECEIVED, (statusAckMessage) => {
            const streamPartId = statusAckMessage.getStreamPartID()
            if (this.streamPartManager.isSetUp(streamPartId) && this.streamPartManager.isNewStream(streamPartId)) {
                this.subscriber.emitJoinCompleted(streamPartId, 0)
            }
        })
        this.nodeToTracker.on(NodeToTrackerEvent.TRACKER_INSTRUCTION_RECEIVED, (instructionMessage, trackerId) => {
            this.instructionThrottler.add(instructionMessage, trackerId)
        })
        this.nodeToTracker.on(NodeToTrackerEvent.TRACKER_DISCONNECTED, (trackerId) => {
            logger.trace('disconnected from tracker %s', trackerId)
        })
    }

    sendStreamPartStatus(streamPartId: StreamPartID): void {
        const trackerId = this.getTrackerId(streamPartId)
        this.sendStatus(streamPartId, trackerId)
    }

    onNewStreamPart(streamPartId: StreamPartID): void {
        this.trackerConnector.onNewStreamPart(streamPartId)
    }

    async connectToSignallingOnlyTracker(trackerId: TrackerId, trackerAddress: string): Promise<void> {
        await this.trackerConnector.createSignallingOnlyTrackerConnection(trackerId, trackerAddress)
    }

    disconnectFromSignallingOnlyTracker(trackerId: string): void {
        this.trackerConnector.removeSignallingOnlyTrackerConnection(trackerId)
    }

    onUnsubscribeFromStreamPart(streamPartId: StreamPartID): void {
        this.instructionThrottler.removeStreamPart(streamPartId)
        this.instructionRetryManager.removeStreamPart(streamPartId)
    }

    start(): void {
        this.trackerConnector.start()
    }

    async stop(): Promise<void> {
        this.instructionThrottler.stop()
        this.instructionRetryManager.stop()
        this.trackerConnector.stop()
        Object.values(this.rttUpdateTimeoutsOnTrackers).forEach((timeout) => clearTimeout(timeout))
        await this.nodeToTracker.stop()
    }

    private getStreamPartsForTracker(trackerId: TrackerId): Array<StreamPartID> {
        return [...this.streamPartManager.getStreamParts()]
            .filter((streamPartId) => this.getTrackerId(streamPartId) === trackerId)
    }

    private shouldIncludeRttInfo(trackerId: TrackerId): boolean {
        if (!(trackerId in this.rttUpdateTimeoutsOnTrackers)) {
            this.rttUpdateTimeoutsOnTrackers[trackerId] = setTimeout(() => {
                logger.trace(`RTT timeout to ${trackerId} triggered, RTTs to connections will be updated with the next status message`)
                delete this.rttUpdateTimeoutsOnTrackers[trackerId]
            }, this.rttUpdateInterval)
            return true
        }
        return false
    }

    private async sendStatus(streamPartId: StreamPartID, trackerId: TrackerId): Promise<void> {
        if (!this.streamPartManager.isBehindProxy(streamPartId)) {
            const nodeDescriptor = this.getNodeDescriptor(this.shouldIncludeRttInfo(trackerId))
            const status = {
                streamPart: this.streamPartManager.getStreamPartStatus(streamPartId),
                ...nodeDescriptor
            }
            try {
                await this.nodeToTracker.sendStatus(trackerId, status)
                logger.trace('sent status %j to tracker %s', status.streamPart, trackerId)
            } catch (e) {
                const error = `failed to send status to tracker ${trackerId}, reason: ${e}`
                if (this.streamPartManager.isSetUp(streamPartId)
                    && this.streamPartManager.isNewStream(streamPartId)) {
                    this.subscriber.emitJoinFailed(streamPartId, error)
                }
                logger.trace(error)
            }
        }
    }

    private async handleTrackerInstruction(
        instructionMessage: TrackerLayer.InstructionMessage,
        trackerId: TrackerId,
        reattempt = false
    ): Promise<void> {
        const streamPartId = instructionMessage.getStreamPartID()
        const { nodeIds, counter } = instructionMessage

        this.instructionRetryManager.add(instructionMessage, trackerId)

        // Check that tracker matches expected tracker
        const expectedTrackerId = this.getTrackerId(streamPartId)
        if (trackerId !== expectedTrackerId) {
            logger.warn(`got instructions from unexpected tracker. Expected ${expectedTrackerId}, got from ${trackerId}`)
            return
        }

        logger.trace('received instructions for %s, nodes to connect %o', streamPartId, nodeIds)

        this.subscriber.subscribeToStreamPartIfHaveNotYet(streamPartId, false)
        const currentNodes = this.streamPartManager.getNeighborsForStreamPart(streamPartId)

        const nodesToUnsubscribeFrom = currentNodes.filter((nodeId) => !nodeIds.includes(nodeId))

        nodesToUnsubscribeFrom.forEach((nodeId) => {
            this.subscriber.unsubscribeFromStreamPartOnNode(nodeId, streamPartId, false)
        })

        const results = await this.subscriber.subscribeToStreamPartOnNodes(nodeIds, streamPartId, trackerId, reattempt)
        let newStream = false
        if (this.streamPartManager.isSetUp(streamPartId)) {
            newStream = this.streamPartManager.isNewStream(streamPartId)
            this.streamPartManager.updateCounter(streamPartId, counter)
        }

        // Log success / failures
        const subscribedNodeIds: NodeId[] = []
        const unsubscribedNodeIds: NodeId[] = []
        let failedInstructions = false
        results.forEach((res, i) => {
            if (res.status === 'fulfilled') {
                subscribedNodeIds.push(res.value)
            } else {
                failedInstructions = true
                logger.debug('failed to subscribe (or connect) to %s, reason: %s', NameDirectory.getName(nodeIds[i]), res.reason)
            }
        })
        if (!reattempt || failedInstructions) {
            this.sendStreamPartStatus(streamPartId)
        }

        if (newStream) {
            if (subscribedNodeIds.length === 0) {
                this.subscriber.emitJoinFailed(streamPartId,
                    `Failed initial join operation to stream partition ${streamPartId},
                            failed to form connections to all target neighbors`
                )
            } else {
                this.subscriber.emitJoinCompleted(streamPartId, subscribedNodeIds.length)
            }
        }

        logger.trace('subscribed to %j and unsubscribed from %j (streamPartId=%s, counter=%d)',
            subscribedNodeIds, unsubscribedNodeIds, streamPartId, counter)

        if (subscribedNodeIds.length !== nodeIds.length) {
            logger.trace('error: failed to fulfill all tracker instructions (streamPartId=%s, counter=%d)', streamPartId, counter)
        } else {
            logger.trace('Tracker instructions fulfilled (streamPartId=%s, counter=%d)', streamPartId, counter)
        }
    }

    getTrackerId(streamPartId: StreamPartID): TrackerId {
        return this.trackerRegistry.getTracker(streamPartId).id
    }

    getTrackerAddress(streamPartId: StreamPartID): TrackerId {
        return this.trackerRegistry.getTracker(streamPartId).ws
    }
}
