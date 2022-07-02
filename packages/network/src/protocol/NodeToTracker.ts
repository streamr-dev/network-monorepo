import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { RelayMessage, RelayMessageSubType, TrackerLayer } from 'streamr-client-protocol'
import { Logger } from '../helpers/Logger'
import { decode } from './utils'
import { Status, NodeId, TrackerId } from '../identifiers'
import { PeerInfo } from '../connection/PeerInfo'
import { NameDirectory } from '../NameDirectory'
import { DisconnectionReason, Event as WsEndpointEvent } from "../connection/ws/AbstractWsEndpoint"
import { AbstractClientWsEndpoint } from "../connection/ws/AbstractClientWsEndpoint"
import { AbstractWsConnection } from "../connection/ws/AbstractWsConnection"

export enum Event {
    CONNECTED_TO_TRACKER = 'streamr:tracker-node:send-status',
    TRACKER_DISCONNECTED = 'streamr:tracker-node:tracker-disconnected',
    TRACKER_INSTRUCTION_RECEIVED = 'streamr:tracker-node:tracker-instruction-received',
    STATUS_ACK_RECEIVED = 'streamr:tracker-node:status-ack-received',
    RELAY_MESSAGE_RECEIVED = 'streamr:tracker-node:relay-message-received',
    RTC_ERROR_RECEIVED = 'streamr:tracker-node:rtc-error-received',
}

const eventPerType: { [key: number]: string } = {}
eventPerType[TrackerLayer.TrackerMessage.TYPES.InstructionMessage] = Event.TRACKER_INSTRUCTION_RECEIVED
eventPerType[TrackerLayer.TrackerMessage.TYPES.StatusAckMessage] = Event.STATUS_ACK_RECEIVED
eventPerType[TrackerLayer.TrackerMessage.TYPES.RelayMessage] = Event.RELAY_MESSAGE_RECEIVED
eventPerType[TrackerLayer.TrackerMessage.TYPES.ErrorMessage] = Event.RTC_ERROR_RECEIVED

export interface NodeToTracker {
    on(event: Event.CONNECTED_TO_TRACKER, listener: (trackerId: TrackerId) => void): this
    on(event: Event.TRACKER_DISCONNECTED, listener: (trackerId: TrackerId) => void): this
    on(event: Event.TRACKER_INSTRUCTION_RECEIVED, listener: (msg: TrackerLayer.InstructionMessage, trackerId: TrackerId) => void): this
    on(event: Event.STATUS_ACK_RECEIVED, listener: (msg: TrackerLayer.StatusAckMessage, trackerId: TrackerId) => void): this
    on(event: Event.RELAY_MESSAGE_RECEIVED, listener: (msg: RelayMessage, trackerId: TrackerId) => void): this
    on(event: Event.RTC_ERROR_RECEIVED, listener: (msg: TrackerLayer.ErrorMessage, trackerId: TrackerId) => void): this
}

export type UUID = string

export class NodeToTracker extends EventEmitter {
    private readonly endpoint: AbstractClientWsEndpoint<AbstractWsConnection>
    private readonly logger: Logger

    constructor(endpoint: AbstractClientWsEndpoint<AbstractWsConnection>) {
        super()
        this.endpoint = endpoint
        this.endpoint.on(WsEndpointEvent.PEER_CONNECTED, (peerInfo) => this.onPeerConnected(peerInfo))
        this.endpoint.on(WsEndpointEvent.PEER_DISCONNECTED, (peerInfo) => this.onPeerDisconnected(peerInfo))
        this.endpoint.on(WsEndpointEvent.MESSAGE_RECEIVED, (peerInfo, message) => this.onMessageReceived(peerInfo, message))
        this.logger = new Logger(module)
    }

    async sendStatus(trackerId: TrackerId, status: Status): Promise<UUID> {
        const requestId = uuidv4()
        await this.send(trackerId, new TrackerLayer.StatusMessage({
            requestId,
            status
        }))
        return requestId
    }

    async sendRtcOffer(
        trackerId: TrackerId,
        targetNode: NodeId, 
        connectionId: string,
        originatorInfo: PeerInfo, 
        description: string
    ): Promise<UUID> {
        const requestId = uuidv4()
        await this.send(trackerId, new TrackerLayer.RelayMessage({
            requestId,
            originator: originatorInfo,
            targetNode,
            subType: RelayMessageSubType.RTC_OFFER,
            data: {
                connectionId,
                description
            }
        }))
        return requestId
    }

    async sendRtcAnswer(
        trackerId: TrackerId,
        targetNode: NodeId, 
        connectionId: string,
        originatorInfo: PeerInfo, 
        description: string
    ): Promise<UUID> {
        const requestId = uuidv4()
        await this.send(trackerId, new TrackerLayer.RelayMessage({
            requestId,
            originator: originatorInfo,
            targetNode,
            subType: RelayMessageSubType.RTC_ANSWER,
            data: {
                connectionId,
                description
            }
        }))
        return requestId
    }

    async sendRtcIceCandidate(
        trackerId: TrackerId,
        targetNode: NodeId, 
        connectionId: string,
        originatorInfo: PeerInfo,
        candidate: string, 
        mid: string
    ): Promise<UUID> {
        const requestId = uuidv4()
        await this.send(trackerId, new TrackerLayer.RelayMessage({
            requestId,
            originator: originatorInfo,
            targetNode,
            subType: RelayMessageSubType.ICE_CANDIDATE,
            data: {
                connectionId,
                candidate,
                mid
            }
        }))
        return requestId
    }

    async sendRtcConnect(trackerId: TrackerId, targetNode: NodeId, originatorInfo: PeerInfo): Promise<UUID> {
        const requestId = uuidv4()
        await this.send(trackerId, new TrackerLayer.RelayMessage({
            requestId,
            originator: originatorInfo,
            targetNode,
            subType: RelayMessageSubType.RTC_CONNECT,
            data: {}
        }))
        return requestId
    }

    async send<T>(receiverTrackerId: TrackerId, message: T & TrackerLayer.TrackerMessage): Promise<void> {
        await this.endpoint.send(receiverTrackerId, message.serialize())
    }

    getServerUrlByTrackerId(trackerId: TrackerId): string | undefined {
        return this.endpoint.getServerUrlByPeerId(trackerId)
    }

    stop(): Promise<void> {
        return this.endpoint.stop()
    }

    onMessageReceived(peerInfo: PeerInfo, rawMessage: string): void {
        if (peerInfo.isTracker()) {
            const message = decode<TrackerLayer.TrackerMessage>(rawMessage, TrackerLayer.TrackerMessage.deserialize)
            if (message != null) {
                this.emit(eventPerType[message.type], message, peerInfo.peerId)
            } else {
                this.logger.warn('invalid message from %s: "%s"', peerInfo, rawMessage)
            }
        }
    }

    connectToTracker(trackerAddress: string, trackerPeerInfo: PeerInfo): Promise<TrackerId> {
        return this.endpoint.connect(trackerAddress, trackerPeerInfo)
    }

    disconnectFromTracker(trackerId: string): void {
        this.endpoint.close(trackerId, 1000, DisconnectionReason.NO_SHARED_STREAM_PARTS)
    }

    onPeerConnected(peerInfo: PeerInfo): void {
        this.logger.debug(`Peer connected: ${NameDirectory.getName(peerInfo.peerId)}`)
        if (peerInfo.isTracker()) {
            this.emit(Event.CONNECTED_TO_TRACKER, peerInfo.peerId)
        }
    }

    onPeerDisconnected(peerInfo: PeerInfo): void {
        if (peerInfo.isTracker()) {
            this.emit(Event.TRACKER_DISCONNECTED, peerInfo.peerId)
        }
    }
}
