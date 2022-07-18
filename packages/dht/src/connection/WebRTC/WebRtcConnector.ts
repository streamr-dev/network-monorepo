import 'setimmediate'
import { EventEmitter } from "events"
import { Event as ConnectionSourceEvents, IConnectionSource } from '../IConnectionSource'
import {
    HandshakeMessage,
    IceCandidate,
    Message,
    MessageType,
    PeerDescriptor,
    RtcAnswer,
    RtcOffer, WebRtcConnectionRequest
} from '../../proto/DhtRpc'
import { Empty } from '../../proto/google/protobuf/empty'
import { ITransport } from '../../transport/ITransport'
import { RoutingRpcCommunicator } from '../../transport/RoutingRpcCommunicator'
import { ConnectionType, Event as ConnectionEvents, IConnection } from '../IConnection'
import { NodeWebRtcConnection } from './NodeWebRtcConnection'
import { RemoteWebrtcConnector } from './RemoteWebrtcConnector'
import { WebRtcConnectorClient } from '../../proto/DhtRpc.client'
import { Event as IWebRtcEvent } from './IWebRtcConnection'
import { PeerID } from '../../helpers/PeerID'
import { DescriptionType } from 'node-datachannel'
import crypto from "crypto"
import { TODO } from '../../types'
import { DeferredConnection } from '../DeferredConnection'
import { Logger } from '@streamr/utils'
import * as Err from '../../helpers/errors'
import { IWebRtcConnector } from "../../proto/DhtRpc.server"
import { ServerCallContext } from '@protobuf-ts/runtime-rpc'
import { UUID } from "../../helpers/UUID"

const logger = new Logger(module)

export interface WebRtcConnectorConfig {
    rpcTransport: ITransport
    canConnect: (peerDescriptor: PeerDescriptor) => boolean
    getConnection: (peerDescriptor: PeerDescriptor) => IConnection | null
    addConnection: (peerDescriptor: PeerDescriptor, connection: IConnection) => boolean
}

export class WebRtcConnector extends EventEmitter implements IConnectionSource, IWebRtcConnector {
    private static WEBRTC_CONNECTOR_APP_ID = 'webrtc_connector'
    private ownPeerDescriptor: PeerDescriptor | null = null
    private rpcCommunicator: RoutingRpcCommunicator
    private rpcTransport: ITransport
    private getManagerConnection: (peerDescriptor: PeerDescriptor) => IConnection | null
    private addManagerConnection: (peerDescriptor: PeerDescriptor, connection: IConnection) => boolean
    constructor(config: WebRtcConnectorConfig) {
        super()
        this.rpcTransport = config.rpcTransport

        this.rpcCommunicator = new RoutingRpcCommunicator(WebRtcConnector.WEBRTC_CONNECTOR_APP_ID, this.rpcTransport, {
            rpcRequestTimeout: 10000
        })

        this.getManagerConnection = config.getConnection
        this.addManagerConnection = config.addConnection

        this.rtcOffer = this.rtcOffer.bind(this)
        this.rtcAnswer = this.rtcAnswer.bind(this)
        this.iceCandidate = this.iceCandidate.bind(this)
        this.requestConnection = this.requestConnection.bind(this)

        this.rpcCommunicator.registerRpcNotification(RtcOffer, 'rtcOffer', this.rtcOffer)
        this.rpcCommunicator.registerRpcNotification(RtcAnswer, 'rtcAnswer', this.rtcAnswer)
        this.rpcCommunicator.registerRpcNotification(IceCandidate, 'iceCandidate', this.iceCandidate)
        this.rpcCommunicator.registerRpcNotification(WebRtcConnectionRequest, 'requestConnection', this.requestConnection)
    }

    connect(targetPeerDescriptor: PeerDescriptor): IConnection {
        if (!PeerID.fromValue(this.ownPeerDescriptor!.peerId).equals(PeerID.fromValue(targetPeerDescriptor.peerId))) {
            logger.trace(`Opening WebRTC connection to ${targetPeerDescriptor.peerId.toString()}`)
            const existingConnection = this.getWebRtcConnection(targetPeerDescriptor)
            if (existingConnection) {
                return existingConnection
            }
            setImmediate(() => {
                const newConnection = this.createConnection(targetPeerDescriptor)
                const added = this.addManagerConnection(targetPeerDescriptor, newConnection)
                if (!added) {
                    newConnection.close()
                }
            })
            return new DeferredConnection(targetPeerDescriptor)
        }
        throw new Err.CannotConnectToSelf('Cannot open WebRTC Connection to self')
    }

    setOwnPeerDescriptor(peerDescriptor: PeerDescriptor): void {
        this.ownPeerDescriptor = peerDescriptor
    }

    getWebRtcConnection(peerDescriptor: PeerDescriptor): NodeWebRtcConnection | null {
        const connection = this.getManagerConnection(peerDescriptor)
        if (connection && connection.connectionType === ConnectionType.WEBRTC) {
            return connection as unknown as NodeWebRtcConnection
        }
        return null
    }

    private createConnection(targetPeerDescriptor: PeerDescriptor, sendRequest = true): NodeWebRtcConnection {
        const connection = new NodeWebRtcConnection({ remotePeerDescriptor: targetPeerDescriptor })
        this.bindListenersAndStartConnection(targetPeerDescriptor, connection, sendRequest)
        return connection
    }

    private onRtcOffer(
        remotePeer: PeerDescriptor,
        targetPeer: PeerDescriptor,
        description: string,
        connectionId: string
    ): void {
        if (!PeerID.fromValue(this.ownPeerDescriptor!.peerId).equals(PeerID.fromValue(targetPeer.peerId))) {
            return
        }
        let connection = this.getWebRtcConnection(remotePeer)
        if (!connection) {
            this.addManagerConnection(remotePeer, new DeferredConnection(remotePeer))
            connection = this.createConnection(remotePeer, false)
            const added = this.addManagerConnection(remotePeer, connection)
            if (!added) {
                connection.close()
            }
        }
        // Always use offerers connectionId
        connection.setConnectionId(connectionId)
        connection.setRemoteDescription(description, DescriptionType.Offer)
    }

    private onRtcAnswer(
        remotePeerDescriptor: PeerDescriptor,
        targetPeerDescriptor: PeerDescriptor,
        description: string,
        connectionId: string
    ): void {
        if (!PeerID.fromValue(this.ownPeerDescriptor!.peerId).equals(PeerID.fromValue(targetPeerDescriptor.peerId))) {
            return
        }
        const connection = this.getWebRtcConnection(remotePeerDescriptor)
        if (!connection) {
            return
        } else if (connection.connectionId.toString() !== connectionId) {
            logger.trace(`Ignoring RTC answer due to connectionId mismatch`)
            return
        }
        connection.setRemoteDescription(description, DescriptionType.Answer)
    }

    private onConnectionRequest(targetPeerDescriptor: PeerDescriptor): void {
        this.addManagerConnection(targetPeerDescriptor, new DeferredConnection(targetPeerDescriptor))
        this.connect(targetPeerDescriptor)
    }
    private onRemoteCandidate(
        remotePeerDescriptor: PeerDescriptor,
        targetPeerDescriptor: PeerDescriptor,
        candidate: string,
        mid: string,
        connectionId: string
    ): void {
        if (!PeerID.fromValue(this.ownPeerDescriptor!.peerId).equals(PeerID.fromValue(targetPeerDescriptor.peerId))) {
            return
        }
        const connection = this.getWebRtcConnection(remotePeerDescriptor)
        if (!connection) {
            return
        } else if (connection.connectionId.toString() !== connectionId) {
            logger.trace(`Ignoring remote candidate due to connectionId mismatch`)
            return
        }
        connection.addRemoteCandidate(candidate, mid)
    }

    stop(): void {
        this.rpcCommunicator.stop()
        this.removeAllListeners()
    }

    bindListenersAndStartConnection(targetPeerDescriptor: PeerDescriptor, connection: NodeWebRtcConnection, sendRequest = true): void {
        if (PeerID.fromValue(this.ownPeerDescriptor!.peerId).equals(PeerID.fromValue(targetPeerDescriptor.peerId))) {
            return
        }
        const offering = this.isOffering(targetPeerDescriptor)
        const remoteConnector = new RemoteWebrtcConnector(
            targetPeerDescriptor,
            new WebRtcConnectorClient(this.rpcCommunicator.getRpcClientTransport())
        )
        if (offering) {
            connection.once(IWebRtcEvent.LOCAL_DESCRIPTION, async (description, _type) => {
                await remoteConnector.sendRtcOffer(this.ownPeerDescriptor!, description, connection.connectionId.toString())
            })
        } else {
            connection.once(IWebRtcEvent.LOCAL_DESCRIPTION, async (description, _type) => {
                await remoteConnector.sendRtcAnswer(this.ownPeerDescriptor!, description, connection.connectionId.toString())
            })
        }
        connection.on(IWebRtcEvent.LOCAL_CANDIDATE, async (candidate, mid) => {
            await remoteConnector.sendIceCandidate(this.ownPeerDescriptor!, candidate, mid, connection.connectionId.toString())
        })
        connection.on(ConnectionEvents.CONNECTED, () => {
            this.emit(ConnectionSourceEvents.CONNECTED, connection)
        })
        connection.start(offering)
        if (offering === false && sendRequest) {
            remoteConnector.requestConnection(this.ownPeerDescriptor!, connection.connectionId.toString())
                .catch(() => { })
        }
    }

    public isOffering(targetPeerDescriptor: PeerDescriptor): boolean {
        const myId = PeerID.fromValue(this.ownPeerDescriptor!.peerId).toMapKey()
        const theirId = PeerID.fromValue(targetPeerDescriptor.peerId).toMapKey()
        return WebRtcConnector.offeringHash(myId + theirId) < WebRtcConnector.offeringHash(theirId + myId)
    }

    private static offeringHash(idPair: string): number {
        const buffer = crypto.createHash('md5').update(idPair).digest()
        return buffer.readInt32LE(0)
    }

    bindListeners(incomingMessageHandler: TODO, protocolVersion: string): void {
        // set up normal listeners that send a handshake for new connections from webSocketConnector
        this.on(ConnectionSourceEvents.CONNECTED, (connection: IConnection) => {
            connection.on(ConnectionEvents.DATA, async (data: Uint8Array) => {
                const message = Message.fromBinary(data)
                if (this.ownPeerDescriptor) {
                    incomingMessageHandler(connection, message)
                }
            })
            if (this.ownPeerDescriptor) {
                logger.trace(`Initiating handshake with ${connection.getPeerDescriptor()?.peerId.toString()}`)
                const outgoingHandshake: HandshakeMessage = {
                    sourceId: this.ownPeerDescriptor.peerId,
                    protocolVersion: protocolVersion,
                    peerDescriptor: this.ownPeerDescriptor
                }

                const msg: Message = {
                    appId: WebRtcConnector.WEBRTC_CONNECTOR_APP_ID,
                    messageType: MessageType.HANDSHAKE,
                    messageId: new UUID().toString(),
                    body: HandshakeMessage.toBinary(outgoingHandshake)
                }

                connection.send(Message.toBinary(msg))
                connection.sendBufferedMessages()
            }
        })
    }

    // IWebRTCConnector implementation

    async requestConnection(request: WebRtcConnectionRequest, _context: ServerCallContext): Promise<Empty> {
        setImmediate(() => this.onConnectionRequest(request.requester!))
        return {}
    }

    async rtcOffer(request: RtcOffer, _context: ServerCallContext): Promise<Empty> {
        setImmediate(() => this.onRtcOffer(request.requester!, request.target!, request.description, request.connectionId))
        return {}
    }

    async rtcAnswer(request: RtcAnswer, _context: ServerCallContext): Promise<Empty> {
        setImmediate(() => this.onRtcAnswer(request.requester!, request.target!, request.description, request.connectionId))
        return {}
    }

    async iceCandidate(request: IceCandidate, _context: ServerCallContext): Promise<Empty> {
        setImmediate(() => this.onRemoteCandidate(request.requester!, request.target!, request.candidate, request.mid, request.connectionId))
        return {}
    }
}
