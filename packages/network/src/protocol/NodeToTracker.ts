import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import {
    ErrorMessage,
    InstructionMessage,
    Receipt,
    RelayMessage,
    RelayMessageSubType,
    StatusMessage,
    TrackerMessage
} from 'streamr-client-protocol'
import { Logger } from "@streamr/utils"
import { decode } from './utils'
import { Status, NodeId, TrackerId } from '../identifiers'
import { PeerInfo } from '../connection/PeerInfo'
import { NameDirectory } from '../NameDirectory'
import { DisconnectionReason, Event as WsEndpointEvent } from "../connection/ws/AbstractWsEndpoint"
import { AbstractClientWsEndpoint } from "../connection/ws/AbstractClientWsEndpoint"
import { AbstractWsConnection } from "../connection/ws/AbstractWsConnection"
import { ResponseAwaiter } from './ResponseAwaiter'

export enum Event {
    CONNECTED_TO_TRACKER = 'streamr:tracker-node:send-status',
    TRACKER_DISCONNECTED = 'streamr:tracker-node:tracker-disconnected',
    TRACKER_INSTRUCTION_RECEIVED = 'streamr:tracker-node:tracker-instruction-received',
    RELAY_MESSAGE_RECEIVED = 'streamr:tracker-node:relay-message-received',
    RTC_ERROR_RECEIVED = 'streamr:tracker-node:rtc-error-received',
}

const eventPerType: Record<number, string> = {}
eventPerType[TrackerMessage.TYPES.InstructionMessage] = Event.TRACKER_INSTRUCTION_RECEIVED
eventPerType[TrackerMessage.TYPES.RelayMessage] = Event.RELAY_MESSAGE_RECEIVED
eventPerType[TrackerMessage.TYPES.ErrorMessage] = Event.RTC_ERROR_RECEIVED

export interface NodeToTracker {
    on(event: Event.CONNECTED_TO_TRACKER, listener: (trackerId: TrackerId) => void): this
    on(event: Event.TRACKER_DISCONNECTED, listener: (trackerId: TrackerId) => void): this
    on(event: Event.TRACKER_INSTRUCTION_RECEIVED, listener: (msg: InstructionMessage, trackerId: TrackerId) => void): this
    on(event: Event.RELAY_MESSAGE_RECEIVED, listener: (msg: RelayMessage, trackerId: TrackerId) => void): this
    on(event: Event.RTC_ERROR_RECEIVED, listener: (msg: ErrorMessage, trackerId: TrackerId) => void): this
}

export type UUID = string

export class NodeToTracker extends EventEmitter {
    private readonly endpoint: AbstractClientWsEndpoint<AbstractWsConnection>
    private readonly responseAwaiter: ResponseAwaiter<TrackerMessage>
    private readonly logger: Logger

    constructor(endpoint: AbstractClientWsEndpoint<AbstractWsConnection>) {
        super()
        this.endpoint = endpoint
        this.responseAwaiter = new ResponseAwaiter<TrackerMessage>(this, [Event.RELAY_MESSAGE_RECEIVED])
        this.endpoint.on(WsEndpointEvent.PEER_CONNECTED, (peerInfo) => this.onPeerConnected(peerInfo))
        this.endpoint.on(WsEndpointEvent.PEER_DISCONNECTED, (peerInfo) => this.onPeerDisconnected(peerInfo))
        this.endpoint.on(WsEndpointEvent.MESSAGE_RECEIVED, (peerInfo, message) => this.onMessageReceived(peerInfo, message))
        this.logger = new Logger(module)
    }

    async sendStatus(trackerId: TrackerId, status: Status): Promise<UUID> {
        const requestId = uuidv4()
        await this.send(trackerId, new StatusMessage({
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
        await this.send(trackerId, new RelayMessage({
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
        await this.send(trackerId, new RelayMessage({
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
        await this.send(trackerId, new RelayMessage({
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
        await this.send(trackerId, new RelayMessage({
            requestId,
            originator: originatorInfo,
            targetNode,
            subType: RelayMessageSubType.RTC_CONNECT,
            data: {}
        }))
        return requestId
    }

    async sendInspectRequestMessage(
        trackerId: TrackerId,
        targetNode: NodeId,
        originatorInfo: PeerInfo,
        inspectionTarget: NodeId
    ): Promise<UUID> {
        const requestId = uuidv4()
        await this.send(trackerId, new RelayMessage({
            requestId,
            originator: originatorInfo,
            targetNode,
            subType: RelayMessageSubType.INSPECT_REQUEST,
            data: {
                inspectionTarget
            }
        }))
        return requestId
    }

    async sendInspectResponsePart(
        trackerId: TrackerId,
        targetNode: NodeId,
        originatorInfo: PeerInfo,
        requestId: string,
        receipt: Receipt | null
    ): Promise<UUID> {
        await this.send(trackerId, new RelayMessage({
            requestId,
            originator: originatorInfo,
            targetNode,
            subType: RelayMessageSubType.INSPECT_RESPONSE_PART,
            data: receipt !== null ? { receipt, done: false } : { done: true }
        }))
        return requestId
    }

    async send<T>(receiverTrackerId: TrackerId, message: T & TrackerMessage): Promise<void> {
        await this.endpoint.send(receiverTrackerId, message.serialize())
    }

    registerRelayMessageHandler(requestId: string, handler: (relayMessage: RelayMessage, source: NodeId) => boolean): void {
        this.responseAwaiter.register(requestId, (msg, source) => {
            if (msg instanceof RelayMessage) {
                return handler(msg, source)
            }
            return false
        })
    }

    getServerUrlByTrackerId(trackerId: TrackerId): string | undefined {
        return this.endpoint.getServerUrlByPeerId(trackerId)
    }

    stop(): Promise<void> {
        return this.endpoint.stop()
    }

    onMessageReceived(peerInfo: PeerInfo, rawMessage: string): void {
        if (peerInfo.isTracker()) {
            const message = decode<TrackerMessage>(rawMessage, TrackerMessage.deserialize)
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
