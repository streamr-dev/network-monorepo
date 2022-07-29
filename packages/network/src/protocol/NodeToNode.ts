import { EventEmitter } from 'events'
import {
    BroadcastMessage,
    ControlMessage,
    ErrorResponse,
    ProxyConnectionRequest,
    ProxyConnectionResponse,
    ProxyDirection,
    ReceiptRequest,
    ReceiptResponse,
    StreamMessage,
    StreamPartID,
    StreamPartIDUtils,
    UnsubscribeRequest
} from 'streamr-client-protocol'
import { Logger } from "@streamr/utils"
import { decode } from './utils'
import { IWebRtcEndpoint, Event as WebRtcEndpointEvent } from '../connection/webrtc/IWebRtcEndpoint'
import { PeerInfo } from '../connection/PeerInfo'
import { Rtts, NodeId } from "../identifiers"
import { ResponseAwaiter } from './ResponseAwaiter'

export enum Event {
    NODE_CONNECTED = 'streamr:node-node:node-connected',
    NODE_DISCONNECTED = 'streamr:node-node:node-disconnected',
    DATA_RECEIVED = 'streamr:node-node:stream-data',
    LOW_BACK_PRESSURE = 'streamr:node-node:low-back-pressure',
    HIGH_BACK_PRESSURE = 'streamr:node-node:high-back-pressure',
    PROXY_CONNECTION_REQUEST_RECEIVED = 'node-node:publish-only-stream-request-received',
    PROXY_CONNECTION_RESPONSE_RECEIVED = 'node-node:publish-only-stream-response-received',
    RECEIPT_REQUEST_RECEIVED = 'node-node:receipt-request-received',
    RECEIPT_RESPONSE_RECEIVED = 'node-node:receipt-response-received',
    ERROR_RESPONSE_RECEIVED = 'node-node:error-response-received',
    LEAVE_REQUEST_RECEIVED = 'node-node:leave-request-received',
    BROADCAST_MESSAGE_SENT = 'node-node:broadcast-message-sent'
}

const eventPerType: Record<number, string> = {}
eventPerType[ControlMessage.TYPES.BroadcastMessage] = Event.DATA_RECEIVED
eventPerType[ControlMessage.TYPES.ProxyConnectionRequest] = Event.PROXY_CONNECTION_REQUEST_RECEIVED
eventPerType[ControlMessage.TYPES.ProxyConnectionResponse] = Event.PROXY_CONNECTION_RESPONSE_RECEIVED
eventPerType[ControlMessage.TYPES.UnsubscribeRequest] = Event.LEAVE_REQUEST_RECEIVED
eventPerType[ControlMessage.TYPES.ReceiptRequest] = Event.RECEIPT_REQUEST_RECEIVED
eventPerType[ControlMessage.TYPES.ReceiptResponse] = Event.RECEIPT_RESPONSE_RECEIVED
eventPerType[ControlMessage.TYPES.ErrorResponse] = Event.ERROR_RESPONSE_RECEIVED

export interface NodeToNode {
    on(event: Event.NODE_CONNECTED, listener: (nodeId: NodeId) => void): this
    on(event: Event.NODE_DISCONNECTED, listener: (nodeId: NodeId) => void): this
    on(event: Event.DATA_RECEIVED, listener: (message: BroadcastMessage, nodeId: NodeId) => void): this
    on(event: Event.LOW_BACK_PRESSURE, listener: (nodeId: NodeId) => void): this
    on(event: Event.HIGH_BACK_PRESSURE, listener: (nodeId: NodeId) => void): this
    on(event: Event.PROXY_CONNECTION_REQUEST_RECEIVED,
       listener: (message: ProxyConnectionRequest, nodeId: NodeId) => void): this
    on(event: Event.PROXY_CONNECTION_RESPONSE_RECEIVED,
       listener: (message: ProxyConnectionResponse, nodeId: NodeId) => void): this
    on(event: Event.RECEIPT_REQUEST_RECEIVED,
       listener: (message: ReceiptRequest, nodeId: NodeId) => void): this
    on(event: Event.RECEIPT_RESPONSE_RECEIVED,
       listener: (message: ReceiptResponse, nodeId: NodeId) => void): this
    on(event: Event.ERROR_RESPONSE_RECEIVED,
       listener: (message: ErrorResponse, nodeId: NodeId) => void): this
    on(event: Event.LEAVE_REQUEST_RECEIVED,
       listener: (message: UnsubscribeRequest, nodeId: NodeId) => void): this
    on(event: Event.BROADCAST_MESSAGE_SENT, listener: (message: BroadcastMessage, recipient: NodeId) => void): this
}

export class NodeToNode extends EventEmitter {
    private readonly endpoint: IWebRtcEndpoint
    private readonly responseAwaiter: ResponseAwaiter<ControlMessage>
    private readonly logger: Logger

    constructor(endpoint: IWebRtcEndpoint) {
        super()
        this.endpoint = endpoint
        this.responseAwaiter = new ResponseAwaiter<ControlMessage>(this, [Event.ERROR_RESPONSE_RECEIVED])
        this.logger = new Logger(module)
        endpoint.on(WebRtcEndpointEvent.PEER_CONNECTED, (peerInfo) => this.onPeerConnected(peerInfo))
        endpoint.on(WebRtcEndpointEvent.PEER_DISCONNECTED, (peerInfo) => this.onPeerDisconnected(peerInfo))
        endpoint.on(WebRtcEndpointEvent.MESSAGE_RECEIVED, (peerInfo, message) => this.onMessageReceived(peerInfo, message))
        endpoint.on(WebRtcEndpointEvent.LOW_BACK_PRESSURE, (peerInfo) => this.onLowBackPressure(peerInfo))
        endpoint.on(WebRtcEndpointEvent.HIGH_BACK_PRESSURE, (peerInfo) => this.onHighBackPressure(peerInfo))
    }

    connectToNode(
        receiverNodeId: NodeId,
        trackerAddress: string,
        trackerInstructed = true
    ): Promise<NodeId> {
        return this.endpoint.connect(receiverNodeId, trackerAddress, trackerInstructed)
    }

    async sendData(receiverNodeId: NodeId, streamMessage: StreamMessage): Promise<BroadcastMessage> {
        const broadcastMessage = await this.send(receiverNodeId, new BroadcastMessage({
            requestId: '', // TODO: how to echo here the requestId of the original SubscribeRequest?
            streamMessage,
        }))
        this.emit(Event.BROADCAST_MESSAGE_SENT, broadcastMessage, receiverNodeId)
        return broadcastMessage
    }

    registerErrorHandler(requestId: string, errorHandler: (errorResponse: ErrorResponse, source: NodeId) => void): void {
        this.responseAwaiter.register(requestId, (msg, source) => {
            if (msg instanceof ErrorResponse) {
                errorHandler(msg, source)
            }
            return true
        })
    }

    send<T>(receiverNodeId: NodeId, message: T & ControlMessage): Promise<T> {
        const [controlLayerVersion, messageLayerVersion] = this.getNegotiatedProtocolVersionsOnNode(receiverNodeId)
        return this.endpoint.send(receiverNodeId, message.serialize(controlLayerVersion, messageLayerVersion)).then(() => message)
    }

    disconnectFromNode(receiverNodeId: NodeId, reason: string): void {
        this.endpoint.close(receiverNodeId, reason)
    }

    /**
     * @deprecated
     */
    getAddress(): string {
        return this.endpoint.getAddress()
    }

    stop(): void {
        this.endpoint.stop()
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

    onMessageReceived(peerInfo: PeerInfo, rawMessage: string): void {
        if (peerInfo.isNode()) {
            const message = decode<ControlMessage>(rawMessage, ControlMessage.deserialize)
            if (message != null) {
                this.emit(eventPerType[message.type], message, peerInfo.peerId)
            } else {
                this.logger.warn('invalid message from %s: %s', peerInfo, rawMessage)
            }
        }
    }

    onLowBackPressure(peerInfo: PeerInfo): void {
        if (peerInfo.isNode()) {
            this.emit(Event.LOW_BACK_PRESSURE, peerInfo.peerId)
        }
    }

    onHighBackPressure(peerInfo: PeerInfo): void {
        if (peerInfo.isNode()) {
            this.emit(Event.HIGH_BACK_PRESSURE, peerInfo.peerId)
        }
    }

    getRtts(): Readonly<Rtts> {
        return this.endpoint.getRtts()
    }

    getNegotiatedProtocolVersionsOnNode(nodeId: NodeId): [number, number] {
        const messageLayerVersion = this.endpoint.getNegotiatedMessageLayerProtocolVersionOnNode(nodeId)
            || this.endpoint.getDefaultMessageLayerProtocolVersion()
        const controlLayerVersion = this.endpoint.getNegotiatedControlLayerProtocolVersionOnNode(nodeId)
            || this.endpoint.getDefaultControlLayerProtocolVersion()
        return [controlLayerVersion, messageLayerVersion]
    }

    async requestProxyConnection(nodeId: NodeId, streamPartId: StreamPartID, direction: ProxyDirection): Promise<void> {
        const [streamId, streamPartition] = StreamPartIDUtils.getStreamIDAndPartition(streamPartId)
        await this.send(nodeId, new ProxyConnectionRequest({
            requestId: '',
            senderId: nodeId,
            streamId,
            streamPartition,
            direction
        }))
    }

    async leaveStreamOnNode(nodeId: NodeId, streamPartId: StreamPartID): Promise<void> {
        const [streamId, streamPartition] = StreamPartIDUtils.getStreamIDAndPartition(streamPartId)
        await this.send(nodeId, new UnsubscribeRequest({
            requestId: '',
            streamId,
            streamPartition
        }))
    }

    async respondToProxyConnectionRequest(nodeId: NodeId, streamPartId: StreamPartID, direction: ProxyDirection, accepted: boolean): Promise<void> {
        const [streamId, streamPartition] = StreamPartIDUtils.getStreamIDAndPartition(streamPartId)
        await this.send(nodeId, new ProxyConnectionResponse({
            requestId: '',
            senderId: nodeId,
            streamId,
            streamPartition,
            direction,
            accepted
        }))
    }

    getAllConnectionNodeIds(): NodeId[] {
        return this.endpoint.getAllConnectionNodeIds()
    }
}
