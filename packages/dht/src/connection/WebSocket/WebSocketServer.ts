import * as http from 'http'
import { EventEmitter } from 'events'
import { server as WsServer } from 'websocket'
import { ServerWebSocket } from './ServerWebSocket'
import {
    IConnectionSource,
    Event as ConnectionSourceEvent,
} from '../IConnectionSource'
import { TODO } from '../../types'
import { Event as ConnectionEvents, IConnection } from '../IConnection'
import { ConnectivityRequestMessage, Message, MessageType, PeerDescriptor } from '../../proto/DhtRpc'
import { Logger } from '@streamr/utils'

const logger = new Logger(module)

declare class NodeJsWsServer extends WsServer { }

export class WebSocketServer extends EventEmitter implements IConnectionSource {

    private httpServer: http.Server | null = null
    private wsServer: WsServer | null = null
    private ownPeerDescriptor: PeerDescriptor | null = null

    start({ host, port }: { host?: string, port?: number } = {}): Promise<void> {
        return new Promise((resolve, reject) => {
            this.httpServer = http.createServer((request, response) => {
                logger.trace((new Date()) + ' Received request for ' + request.url)
                response.writeHead(404)
                response.end()
            })

            if (host) {
                this.httpServer.listen(port, host, () => {
                    logger.info((new Date()) + ' Server is listening on port ' + port)
                    resolve()
                })
            } else if (port) {
                this.httpServer.listen(port, () => {
                    logger.info((new Date()) + ' Server is listening on port ' + port)
                    resolve()
                })
            } else {
                reject('Listen port for WebSocket server not given')
            }

            if (typeof NodeJsWsServer !== 'undefined') {
                this.wsServer = new NodeJsWsServer({
                    httpServer: this.httpServer,
                    autoAcceptConnections: false
                })
            } else {
                this.wsServer = new WsServer({
                    httpServer: this.httpServer,
                    // You should not use autoAcceptConnections for production
                    // applications, as it defeats all standard cross-origin protection
                    // facilities built into the protocol and the browser.  You should
                    // *always* verify the connection's origin and decide whether or not
                    // to accept it.
                    autoAcceptConnections: false
                })
            }

            function originIsAllowed(_uorigin: string) {
                // put logic here to detect whether the specified origin is allowed.
                return true
            }

            this.wsServer.on('request', (request) => {
                if (!originIsAllowed(request.origin)) {
                    // Make sure we only accept requests from an allowed origin
                    request.reject()
                    logger.trace((new Date()) + ' IConnection from origin ' + request.origin + ' rejected.')
                    return
                }

                const connection = request.accept(undefined, request.origin)

                logger.trace((new Date()) + ' IConnection accepted.')

                this.emit(ConnectionSourceEvent.CONNECTED, new ServerWebSocket(connection))
            })
        })
    }

    bindListeners(connectivityRequestHandler: TODO, incomingMessageHandler: TODO): void {
        this.on(ConnectionSourceEvent.CONNECTED, (connection: IConnection) => {
            logger.trace('server received new connection')

            connection.on(ConnectionEvents.DATA, async (data: Uint8Array) => {
                logger.trace('server received data')
                const message = Message.fromBinary(data)

                if (message.messageType === MessageType.CONNECTIVITY_REQUEST) {
                    logger.trace('received connectivity request')
                    connectivityRequestHandler(connection, ConnectivityRequestMessage.fromBinary(message.body))
                } else {
                    if (this.isInitialized()) {
                        incomingMessageHandler(connection, message)
                    }
                }
            })
        })
    }

    setOwnPeerDescriptor(peerDescriptor: PeerDescriptor): void {
        this.ownPeerDescriptor = peerDescriptor
    }

    private isInitialized(): boolean {
        if (this.ownPeerDescriptor) {
            return true
        }
        return false
    }

    stop(): Promise<void> {
        this.removeAllListeners()
        return new Promise((resolve, _reject) => {
            this.wsServer?.shutDown()
            this.httpServer?.close(() => {
                resolve()
            })
        })
    }
}
