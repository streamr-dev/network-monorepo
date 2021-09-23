import { EventEmitter } from 'events'
import { Logger } from '../helpers/Logger'
import { Metrics, MetricsContext } from '../helpers/MetricsContext'
import { TrackerServer, Event as TrackerServerEvent } from '../protocol/TrackerServer'
import { StatusMessage } from 'streamr-client-protocol'
import { OverlayTopology } from './OverlayTopology'
import { InstructionCounter } from './InstructionCounter'
import { LocationManager } from './LocationManager'
import { attachRtcSignalling } from './rtcSignallingHandlers'
import { PeerInfo } from '../connection/PeerInfo'
import { Location, Status, StatusStreams, StreamKey, TrackerRecord } from '../identifiers'
import { NodeId } from './Node'
import { InstructionSender } from './InstructionSender'

export type TrackerId = string

type StreamId = string

export enum Event {
    NODE_CONNECTED = 'streamr:tracker:node-connected'
}

export interface TopologyStabilizationOptions {
    debounceWait: number
    maxWait: number
}

export interface TrackerOptions {
    maxNeighborsPerNode: number
    peerInfo: PeerInfo
    protocols: {
        trackerServer: TrackerServer
    }
    metricsContext?: MetricsContext,
    topologyStabilization?: TopologyStabilizationOptions
}

export type OverlayPerStream = Record<StreamKey,OverlayTopology>

// nodeId => connected nodeId => rtt
export type OverlayConnectionRtts = Record<NodeId,Record<NodeId,number>>

export interface Tracker {
    on(event: Event.NODE_CONNECTED, listener: (nodeId: NodeId) => void): this
}

export class Tracker extends EventEmitter {
    private readonly maxNeighborsPerNode: number
    private readonly trackerServer: TrackerServer
    private readonly peerInfo: PeerInfo
    private readonly overlayPerStream: OverlayPerStream
    private readonly overlayConnectionRtts: OverlayConnectionRtts
    private readonly locationManager: LocationManager
    private readonly instructionCounter: InstructionCounter
    private readonly instructionSender: InstructionSender
    private readonly extraMetadatas: Record<NodeId,Record<string, unknown>>
    private readonly logger: Logger
    private readonly metrics: Metrics

    constructor(opts: TrackerOptions) {
        super()

        if (!Number.isInteger(opts.maxNeighborsPerNode)) {
            throw new Error('maxNeighborsPerNode is not an integer')
        }
        if (!(opts.protocols.trackerServer instanceof TrackerServer)) {
            throw new Error('Provided protocols are not correct')
        }

        const metricsContext = opts.metricsContext || new MetricsContext('')
        this.maxNeighborsPerNode = opts.maxNeighborsPerNode
        this.trackerServer = opts.protocols.trackerServer
        this.peerInfo = opts.peerInfo

        this.logger = new Logger(module)
        this.overlayPerStream = {}
        this.overlayConnectionRtts = {}
        this.locationManager = new LocationManager()
        this.instructionCounter = new InstructionCounter()
        this.extraMetadatas = Object.create(null)

        this.trackerServer.on(TrackerServerEvent.NODE_CONNECTED, (nodeId) => {
            this.onNodeConnected(nodeId)
        })
        this.trackerServer.on(TrackerServerEvent.NODE_DISCONNECTED, (nodeId) => {
            this.onNodeDisconnected(nodeId)
        })
        this.trackerServer.on(TrackerServerEvent.NODE_STATUS_RECEIVED, (statusMessage, nodeId) => {
            this.processNodeStatus(statusMessage, nodeId)
        })
        attachRtcSignalling(this.trackerServer)

        this.metrics = metricsContext.create('tracker')
            .addRecordedMetric('onNodeDisconnected')
            .addRecordedMetric('processNodeStatus')
            .addRecordedMetric('instructionsSent')
            .addRecordedMetric('_removeNode')

        this.instructionSender = new InstructionSender(opts.topologyStabilization, this.trackerServer, this.metrics)
    }

    onNodeConnected(node: NodeId): void {
        this.emit(Event.NODE_CONNECTED, node)
    }

    onNodeDisconnected(node: NodeId): void {
        this.logger.debug('node %s disconnected', node)
        this.metrics.record('onNodeDisconnected', 1)
        this.removeNode(node)
    }

    processNodeStatus(statusMessage: StatusMessage, source: NodeId): void {
        this.metrics.record('processNodeStatus', 1)
        const status = statusMessage.status as Status
        const { streams, rtts, location, singleStream, extra } = status
        const filteredStreams = this.instructionCounter.filterStatus(status, source)

        // update RTTs and location
        if (rtts) {
            this.overlayConnectionRtts[source] = rtts
        }
        this.locationManager.updateLocation({
            nodeId: source,
            location,
            address: this.trackerServer.resolveAddress(source),
        })
        this.extraMetadatas[source] = extra

        // update topology
        this.createNewOverlayTopologies(streams)
        if (singleStream) {
            this.updateNodeOnStream(source, filteredStreams)
        } else {
            this.updateNode(source, filteredStreams, streams)
        }
        this.formAndSendInstructions(source, Object.keys(streams))
    }

    stop(): Promise<void> {
        this.logger.debug('stopping')
        return this.trackerServer.stop()
    }

    // Utility method for tests
    getUrl(): string {
        return this.trackerServer.getUrl()
    }

    private createNewOverlayTopologies(streams: StatusStreams) {
        Object.keys(streams).forEach((streamId) => {
            if (this.overlayPerStream[streamId] == null) {
                this.overlayPerStream[streamId] = new OverlayTopology(this.maxNeighborsPerNode)
            }
        })
    }

    private updateNode(node: NodeId, filteredStreams: StatusStreams, allStreams: StatusStreams): void {
        // Add or update
        Object.entries(filteredStreams).forEach(([streamKey, { inboundNodes, outboundNodes }]) => {
            const neighbors = new Set([...inboundNodes, ...outboundNodes])
            this.overlayPerStream[streamKey].update(node, [...neighbors])
        })

        // Remove
        const currentStreamKeys: Set<StreamKey> = new Set(Object.keys(allStreams))
        Object.entries(this.overlayPerStream)
            .filter(([streamKey, _]) => !currentStreamKeys.has(streamKey))
            .forEach(([streamKey, overlayTopology]) => {
                this.leaveAndCheckEmptyOverlay(streamKey, overlayTopology, node)
            })
    }

    private updateNodeOnStream(node: NodeId, streams: StatusStreams): void {
        if (streams && Object.keys(streams).length === 1) {
            const streamKey = Object.keys(streams)[0]
            const status = streams[streamKey]
            if (status.counter === -1) {
                this.leaveAndCheckEmptyOverlay(streamKey, this.overlayPerStream[streamKey], node)
            } else {
                const neighbors = new Set([...status.inboundNodes, ...status.outboundNodes])
                this.overlayPerStream[streamKey].update(node, [...neighbors])
            }
        } else {
            this.logger.debug('unexpected empty single-stream status received from node %s, contents %j', node, streams)
        }
    }

    private formAndSendInstructions(node: NodeId, streamKeys: Array<StreamKey>, forceGenerate = false): void {
        streamKeys.forEach((streamKey) => {
            if (this.overlayPerStream[streamKey]) {
                const instructions = this.overlayPerStream[streamKey].formInstructions(node, forceGenerate)
                Object.entries(instructions).forEach(async ([nodeId, newNeighbors]) => {
                    const counterValue = this.instructionCounter.setOrIncrement(nodeId, streamKey)
                    await this.instructionSender.addInstruction({
                        nodeId,
                        streamKey,
                        newNeighbors,
                        counterValue
                    })
                })
            }
        })
    }

    private removeNode(node: NodeId): void {
        this.metrics.record('_removeNode', 1)
        delete this.overlayConnectionRtts[node]
        this.locationManager.removeNode(node)
        delete this.extraMetadatas[node]
        Object.entries(this.overlayPerStream)
            .forEach(([streamKey, overlayTopology]) => {
                this.leaveAndCheckEmptyOverlay(streamKey, overlayTopology, node)
            })
    }

    private leaveAndCheckEmptyOverlay(streamKey: StreamKey, overlayTopology: OverlayTopology, node: NodeId) {
        const neighbors = overlayTopology.leave(node)
        this.instructionCounter.removeNode(node)

        if (overlayTopology.isEmpty()) {
            this.instructionCounter.removeStream(streamKey)
            delete this.overlayPerStream[streamKey]
        } else {
            neighbors.forEach((neighbor) => {
                this.formAndSendInstructions(neighbor, [streamKey], true)
            })
        }
    }

    getStreams(): ReadonlyArray<StreamId> {
        return Object.keys(this.overlayPerStream)
    }

    getAllNodeLocations(): Readonly<Record<NodeId,Location>> {
        return this.locationManager.getAllNodeLocations()
    }

    getAllExtraMetadatas(): Readonly<Record<NodeId,Record<string, unknown>>> {
        return this.extraMetadatas
    }

    getNodes(): ReadonlyArray<NodeId> {
        return this.trackerServer.getNodeIds()
    }

    getNodeLocation(node: NodeId): Location {
        return this.locationManager.getNodeLocation(node)
    }

    getOverlayConnectionRtts(): OverlayConnectionRtts {
        return this.overlayConnectionRtts
    }

    getOverlayPerStream(): Readonly<OverlayPerStream> {
        return this.overlayPerStream
    }

    getTrackerRecord(): TrackerRecord {
        return {
            id: this.peerInfo.peerId,
            http: this.getUrl().replace(/^ws/, 'http'),
            ws: this.getUrl()
        }
    }
}
