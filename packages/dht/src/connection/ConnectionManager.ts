import EventEmitter from 'events'
import {
    ConnectivityRequestMessage,
    ConnectivityResponseMessage,
    HandshakeMessage,
    Message,
    MessageType,
    PeerDescriptor
} from '../proto/DhtRpc'
import { ConnectionType, Event as ConnectionEvents, IConnection } from './IConnection'
import { WebSocketConnector } from './WebSocket/WebSocketConnector'
import { WebSocketServer } from './WebSocket/WebSocketServer'
import { ServerWebSocket } from './WebSocket/ServerWebSocket'
import { PeerID, PeerIDKey } from '../helpers/PeerID'
import { Event, ITransport } from '../transport/ITransport'
import { WebRtcConnector } from './WebRTC/WebRtcConnector'
import { Logger } from '@streamr/utils'
import * as Err from '../helpers/errors'
import { WEB_RTC_CLEANUP } from './WebRTC/NodeWebRtcConnection'
import { v4 } from 'uuid'

export interface ConnectionManagerConfig {
    transportLayer: ITransport
    webSocketHost?: string
    webSocketPort?: number
    entryPoints?: PeerDescriptor[]
}

export enum NatType {
    OPEN_INTERNET = 'open_internet',
    UNKNOWN =  'unknown'
}

const DEFAULT_DISCONNECTION_TIMEOUT = 10000

const logger = new Logger(module)

export class ConnectionManager extends EventEmitter implements ITransport {
    public static PROTOCOL_VERSION = '1.0'
    private static CONNECTION_MANAGER_APP_ID = 'connectionmanager'
    private stopped = false
    private started = false

    private ownPeerDescriptor: PeerDescriptor | null = null
    private connections: Map<PeerIDKey, IConnection> = new Map()

    private disconnectionTimeouts: Map<PeerIDKey, NodeJS.Timeout> = new Map()
    private webSocketConnector: WebSocketConnector
    private webrtcConnector: WebRtcConnector

    private webSocketServer: WebSocketServer | null

    constructor(private config: ConnectionManagerConfig) {
        super()
        this.webSocketServer = (config.webSocketPort !== undefined) ? new WebSocketServer() : null
        this.webSocketConnector = this.createWsConnector()
        this.webrtcConnector = this.createWebRtcConnector()
    }

    private async handleIncomingConnectivityRequest(
        connection: IConnection,
        connectivityRequest: ConnectivityRequestMessage
    ): Promise<void> {
        if (!this.started || this.stopped) {
            return
        }
        let outgoingConnection: IConnection | null = null
        let connectivityResponseMessage: ConnectivityResponseMessage | null = null
        try {
            outgoingConnection = await this.webSocketConnector!.connectAsync({
                host: (connection as ServerWebSocket).getRemoteAddress(),
                port: connectivityRequest.port, timeoutMs: 1000
            })
        } catch (e) {
            logger.trace("Connectivity test produced negative result, communicating reply to the requester")
            logger.debug(e)

            connectivityResponseMessage = {
                openInternet: false,
                ip: (connection as ServerWebSocket).getRemoteAddress(),
                natType: NatType.UNKNOWN
            }
        }

        if (outgoingConnection) {
            outgoingConnection.close()

            logger.trace("Connectivity test produced positive result, communicating reply to the requester")

            connectivityResponseMessage = {
                openInternet: true,
                ip: (connection as ServerWebSocket).getRemoteAddress(),
                natType: NatType.OPEN_INTERNET,
                websocket: { ip: (connection as ServerWebSocket).getRemoteAddress(), port: connectivityRequest.port }
            }
        }

        const msg: Message = {
            appId: ConnectionManager.CONNECTION_MANAGER_APP_ID,
            messageType: MessageType.CONNECTIVITY_RESPONSE, messageId: v4(),
            body: ConnectivityResponseMessage.toBinary(connectivityResponseMessage!)
        }
        connection.send(Message.toBinary(msg))
    }

    private async sendConnectivityRequest(): Promise<ConnectivityResponseMessage> {
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            const entryPoint = this.config.entryPoints![0]

            let outgoingConnection: IConnection | null = null

            try {
                outgoingConnection = await this.webSocketConnector!.connectAsync({
                    host: entryPoint.websocket?.ip, port: entryPoint.websocket?.port, timeoutMs: 1000
                })
            } catch (e) {
                logger.error("Failed to connect to the entrypoints")

                reject(new Error('Failed to connect to the entrypoints'))
            }

            if (outgoingConnection) {

                // prepare for receiving a connectivity reply
                outgoingConnection.once(ConnectionEvents.DATA, (bytes) => {
                    const message: Message = Message.fromBinary(bytes)
                    const connectivityResponseMessage = ConnectivityResponseMessage.fromBinary(message.body)

                    resolve(connectivityResponseMessage)
                })

                // send connectivity request
                const connectivityRequestMessage: ConnectivityRequestMessage = { port: this.config.webSocketPort! }
                const msg: Message = {
                    appId: ConnectionManager.CONNECTION_MANAGER_APP_ID,
                    messageType: MessageType.CONNECTIVITY_REQUEST, messageId: 'xyz',
                    body: ConnectivityRequestMessage.toBinary(connectivityRequestMessage)
                }

                outgoingConnection.once(ConnectionEvents.ERROR, () => {
                    logger.trace('clientsocket error')
                })

                logger.trace('trying to send connectivity request')
                outgoingConnection.send(Message.toBinary(msg))
                logger.trace('connectivity request sent: ' + JSON.stringify(Message.toJson(msg)))
            }
        })
    }

    async start(): Promise<ConnectivityResponseMessage> {
        if (this.started || this.stopped) {
            throw new Err.CouldNotStart(`Cannot start already ${this.started ? 'started' : 'stopped'} module`)
        }
        this.started = true
        logger.info(`Starting ConnectionManager...`)
        // Set up and start websocket server
        if (this.webSocketServer) {
            this.webSocketServer.bindListeners(
                this.handleIncomingConnectivityRequest.bind(this),
                this.onIncomingMessage.bind(this)
            )

            await this.webSocketServer.start({ host: this.config.webSocketHost, port: this.config.webSocketPort })

            // eslint-disable-next-line no-async-promise-executor
            return new Promise(async (resolve, reject) => {
                // Open websocket connection to one of the entrypoints and send a CONNECTIVITY_REQUEST message

                if (this.config.entryPoints && this.config.entryPoints.length > 0) {
                    this.sendConnectivityRequest().then((response) => resolve(response)).catch((err) => reject(err))
                } else {
                    // return connectivity info given in config to be used for id generation

                    const connectivityResponseMessage: ConnectivityResponseMessage = {
                        openInternet: true,
                        ip: this.config.webSocketHost!,
                        natType: NatType.OPEN_INTERNET,
                        websocket: { ip: this.config.webSocketHost!, port: this.config.webSocketPort! }
                    }
                    resolve(connectivityResponseMessage)
                }
            })
        }
        const connectivityResponseMessage: ConnectivityResponseMessage = {
            openInternet: false,
            ip: 'localhost',
            natType: NatType.UNKNOWN
        }
        return connectivityResponseMessage
    }

    enableConnectivity(ownPeerDescriptor: PeerDescriptor): void {
        if (!this.started || this.stopped) {
            return
        }
        this.ownPeerDescriptor = ownPeerDescriptor
        this.webSocketConnector!.setOwnPeerDescriptor(ownPeerDescriptor)
        if (this.webSocketServer) {
            this.webSocketServer.setOwnPeerDescriptor(ownPeerDescriptor)
        }
        if (this.webrtcConnector) {
            this.webrtcConnector.setOwnPeerDescriptor(ownPeerDescriptor)
            this.webrtcConnector.bindListeners(this.onIncomingMessage.bind(this), ConnectionManager.PROTOCOL_VERSION)
        }

        this.webSocketConnector!.bindListeners(this.onIncomingMessage.bind(this), ConnectionManager.PROTOCOL_VERSION)
    }

    onIncomingMessage = (connection: IConnection, message: Message): void => {
        if (!this.started || this.stopped) {
            return
        }
        if (message.messageType === MessageType.HANDSHAKE && this.ownPeerDescriptor) {
            const handshake = HandshakeMessage.fromBinary(message.body)
            const hexId = PeerID.fromValue(handshake.sourceId).toMapKey()
            connection.setPeerDescriptor(handshake.peerDescriptor as PeerDescriptor)
            const isDeferredConnection = (this.connections.has(hexId) && this.connections.get(hexId)!.connectionType === ConnectionType.DEFERRED)
            if (!this.connections.has(hexId) || isDeferredConnection) {
                let oldConnection
                if (isDeferredConnection) {
                    oldConnection = this.connections.get(hexId)
                }
                this.connections.set(hexId, connection)

                const outgoingHandshake: HandshakeMessage = {
                    sourceId: this.ownPeerDescriptor.peerId,
                    protocolVersion: ConnectionManager.PROTOCOL_VERSION,
                    peerDescriptor: this.ownPeerDescriptor
                }
                const msg: Message = {
                    appId: ConnectionManager.CONNECTION_MANAGER_APP_ID,
                    messageType: MessageType.HANDSHAKE, 
                    messageId: v4(),
                    body: HandshakeMessage.toBinary(outgoingHandshake)
                }
                connection.send(Message.toBinary(msg))
                if (oldConnection) {
                    oldConnection.getBufferedMessages().forEach((msg) => {
                        connection.send(msg)
                    })
                    oldConnection.close()
                }
            }
        } else {
            this.emit(Event.DATA, message, connection.getPeerDescriptor())
        }
    }

    async stop(): Promise<void> {
        if (!this.started) {
            return
        }
        this.stopped = true
        logger.trace(`Stopping ConnectionManager`)
        this.removeAllListeners()
        if (this.webSocketServer) {
            await this.webSocketServer.stop()
        }
        [...this.disconnectionTimeouts.values()].map(async (timeout) => {
            clearTimeout(timeout)
        })
        this.disconnectionTimeouts.clear()
        this.webSocketConnector.stop()
        this.webrtcConnector.stop()

        this.connections.forEach((connection) => connection.close())
        WEB_RTC_CLEANUP.cleanUp()
    }

    async send(message: Message, peerDescriptor: PeerDescriptor): Promise<void> {
        if (!this.started || this.stopped) {
            return
        }
        const hexId = PeerID.fromValue(peerDescriptor.peerId).toMapKey()
        if (PeerID.fromValue(this.ownPeerDescriptor!.peerId).equals(PeerID.fromValue(peerDescriptor.peerId))) {
            throw new Err.CannotConnectToSelf('Cannot send to self')
        }
        logger.trace(`Sending message to: ${peerDescriptor.peerId.toString()}`)

        if (this.connections.has(hexId)) {
            this.connections.get(hexId)!.send(Message.toBinary(message))
        } else if (peerDescriptor.websocket) {
            const connection = this.webSocketConnector!.connect({
                host: peerDescriptor.websocket.ip,
                port: peerDescriptor.websocket.port
            })
            connection.setPeerDescriptor(peerDescriptor)
            this.connections.set(hexId, connection)
            connection.send(Message.toBinary(message))
        } else if (this.ownPeerDescriptor!.websocket && !peerDescriptor.websocket) {
            const connection = this.webSocketConnector!.connect({
                ownPeerDescriptor: this.ownPeerDescriptor!,
                targetPeerDescriptor: peerDescriptor
            })
            this.connections.set(hexId, connection)
            connection.send(Message.toBinary(message))
        } else if (this.webrtcConnector) {
            const connection = this.webrtcConnector.connect(peerDescriptor)
            this.connections.set(hexId, connection)
            connection.send(Message.toBinary(message))
        }
    }

    disconnect(peerDescriptor: PeerDescriptor, reason?: string, timeout = DEFAULT_DISCONNECTION_TIMEOUT): void {
        if (!this.started || this.stopped) {
            return
        }
        const hexId = PeerID.fromValue(peerDescriptor.peerId).toMapKey()
        this.disconnectionTimeouts.set(hexId, setTimeout(() => {
            this.closeConnection(hexId, reason)
            this.disconnectionTimeouts.delete(hexId)
        }, timeout))
    }

    private closeConnection(id: PeerIDKey, reason?: string): void {
        if (!this.started || this.stopped) {
            return
        }
        if (this.connections.has(id)) {
            logger.trace(`Disconnecting from Peer ${id}${reason ? `: ${reason}` : ''}`)
            this.connections.get(id)!.close()
        }
    }

    getConnection(peerDescriptor: PeerDescriptor): IConnection | null {
        const hexId = PeerID.fromValue(peerDescriptor.peerId).toMapKey()
        return this.connections.get(hexId) || null
    }

    getPeerDescriptor(): PeerDescriptor {
        return this.ownPeerDescriptor!
    }

    hasConnection(peerDescriptor: PeerDescriptor): boolean {
        const hexId = PeerID.fromValue(peerDescriptor.peerId).toMapKey()
        return this.connections.has(hexId)
    }

    canConnect(peerDescriptor: PeerDescriptor, _ip: string, _port: number): boolean {
        // Perhaps the connection's state should be checked here
        return !this.hasConnection(peerDescriptor) // TODO: Add port range check
    }

    addConnection(peerDescriptor: PeerDescriptor, connection: IConnection, replaceDeferred = true): boolean {
        if (!this.started || this.stopped) {
            return false
        }
        if (!this.hasConnection(peerDescriptor)
            || (replaceDeferred
                && this.hasConnection(peerDescriptor)
                && this.getConnection(peerDescriptor)!.connectionType === ConnectionType.DEFERRED)
        ) {

            this.connections.set(PeerID.fromValue(peerDescriptor.peerId).toMapKey(), connection)
            return true
        }
        return false
    }

    private createWsConnector(): WebSocketConnector {
        logger.trace(`Creating WebSocket Connector`)
        return new WebSocketConnector(this.config.transportLayer, this.canConnect.bind(this))
    }

    private createWebRtcConnector(): WebRtcConnector {
        logger.trace(`Creating WebRTC Connector`)
        return  new WebRtcConnector({
            rpcTransport: this.config.transportLayer,
            canConnect: () => true,
            getConnection: this.getConnection.bind(this),
            addConnection: this.addConnection.bind(this)
        })
    }
}
