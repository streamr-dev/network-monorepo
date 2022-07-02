import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import {
    StreamPartID,
    StreamPartIDUtils,
    TrackerLayer,
    TrackerMessageType
} from 'streamr-client-protocol'
import {
    decode,
    DisconnectionCode,
    DisconnectionReason,
    Logger,
    NameDirectory,
    NodeId,
    PeerId,
    PeerInfo,
    ServerWsEndpoint,
    WsEndpointEvent
} from 'streamr-network'

export enum Event {
    NODE_CONNECTED = 'streamr:tracker:send-peers',
    NODE_DISCONNECTED = 'streamr:tracker:node-disconnected',
    NODE_STATUS_RECEIVED = 'streamr:tracker:peer-status',
    RELAY_MESSAGE_RECEIVED = 'streamr:tracker:relay-message-received'
}

const eventPerType: { [key: number]: string } = {}
eventPerType[TrackerLayer.TrackerMessage.TYPES.StatusMessage] = Event.NODE_STATUS_RECEIVED
eventPerType[TrackerLayer.TrackerMessage.TYPES.RelayMessage] = Event.RELAY_MESSAGE_RECEIVED

export interface NodeToTracker {
    on(event: Event.NODE_CONNECTED, listener: (nodeId: NodeId) => void): this
    on(event: Event.NODE_DISCONNECTED, listener: (nodeId: NodeId) => void): this
    on(event: Event.NODE_STATUS_RECEIVED, listener: (msg: TrackerLayer.StatusMessage, nodeId: NodeId) => void): this
    on(event: Event.RELAY_MESSAGE_RECEIVED, listener: (msg: TrackerLayer.RelayMessage, nodeId: NodeId) => void): this
}

export class TrackerServer extends EventEmitter {
    private readonly endpoint: ServerWsEndpoint
    private readonly logger: Logger

    constructor(endpoint: ServerWsEndpoint) {
        super()
        this.endpoint = endpoint
        endpoint.on(WsEndpointEvent.PEER_CONNECTED, (peerInfo) => this.onPeerConnected(peerInfo))
        endpoint.on(WsEndpointEvent.PEER_DISCONNECTED, (peerInfo) => this.onPeerDisconnected(peerInfo))
        endpoint.on(WsEndpointEvent.MESSAGE_RECEIVED, (peerInfo, message) => this.onMessageReceived(peerInfo, message))
        this.logger = new Logger(module)
    }

    async sendInstruction(
        receiverNodeId: NodeId,
        streamPartId: StreamPartID,
        nodeIds: NodeId[],
        counter: number
    ): Promise<void> {
        const [streamId, streamPartition] = StreamPartIDUtils.getStreamIDAndPartition(streamPartId)
        await this.send(receiverNodeId, new TrackerLayer.InstructionMessage({
            requestId: uuidv4(),
            streamId,
            streamPartition,
            nodeIds,
            counter
        }))
    }

    async sendStatusAck(
        receiverNodeId: NodeId,
        streamPartId: StreamPartID
    ): Promise<void> {
        const [streamId, streamPartition] = StreamPartIDUtils.getStreamIDAndPartition(streamPartId)
        await this.send(receiverNodeId, new TrackerLayer.StatusAckMessage({
            requestId: uuidv4(),
            streamId,
            streamPartition
        }))
    }

    async sendUnknownPeerError(receiverNodeId: NodeId, requestId: string, targetNode: NodeId): Promise<void> {
        await this.send(receiverNodeId, new TrackerLayer.ErrorMessage({
            requestId,
            errorCode: TrackerLayer.ErrorMessage.ERROR_CODES.UNKNOWN_PEER,
            targetNode
        }))
    }

    async send<T>(receiverNodeId: NodeId, message: T & TrackerLayer.TrackerMessage): Promise<void> {
        this.logger.debug(`Send ${TrackerMessageType[message.type]} to ${NameDirectory.getName(receiverNodeId)}`)
        await this.endpoint.send(receiverNodeId, message.serialize())
    }

    getNodeIds(): NodeId[] {
        return this.endpoint.getPeerInfos()
            .filter((peerInfo) => peerInfo.isNode())
            .map((peerInfo) => peerInfo.peerId)
    }

    getUrl(): string {
        return this.endpoint.getUrl()
    }

    resolveAddress(peerId: PeerId): string | undefined {
        return this.endpoint.resolveAddress(peerId)
    }

    stop(): Promise<void> {
        return this.endpoint.stop()
    }

    onPeerConnected(peerInfo: PeerInfo): void {
        if (peerInfo.isNode()) {
            this.emit(Event.NODE_CONNECTED, peerInfo.peerId)
        }
    }

    onPeerDisconnected(peerInfo: PeerInfo): void {
        if (peerInfo.isNode()) {
            this.emit(Event.NODE_DISCONNECTED, peerInfo.peerId)
        }
    }

    disconnectFromPeer(peerId: string, code = DisconnectionCode.GRACEFUL_SHUTDOWN, reason = DisconnectionReason.GRACEFUL_SHUTDOWN): void {
        this.endpoint.close(peerId, code, reason)
    }

    onMessageReceived(peerInfo: PeerInfo, rawMessage: string): void {
        if (peerInfo.isNode()) {
            const message = decode<TrackerLayer.TrackerMessage>(rawMessage, TrackerLayer.TrackerMessage.deserialize)
            if (message != null) {
                this.emit(eventPerType[message.type], message, peerInfo.peerId)
            } else {
                this.logger.warn('invalid message from %s: %s', peerInfo, rawMessage)
            }
        }
    }
}
