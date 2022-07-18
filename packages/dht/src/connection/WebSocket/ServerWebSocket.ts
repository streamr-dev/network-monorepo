import { EventEmitter } from 'events'
import { IConnection, ConnectionID, Event as ConnectionEvent, ConnectionType } from '../IConnection'
import { connection as WsConnection } from 'websocket'
import { PeerDescriptor } from '../../proto/DhtRpc'
import { Logger } from '@streamr/utils'

const logger = new Logger(module)

declare let NodeJsBuffer: BufferConstructor

enum MessageType {
    UTF8 = 'utf8',
    BINARY = 'binary'
}

export class ServerWebSocket extends EventEmitter implements IConnection {
   
    public connectionId: ConnectionID
    private socket: WsConnection
    private remotePeerDescriptor?: PeerDescriptor
    connectionType = ConnectionType.WEBSOCKET_SERVER

    constructor(socket: WsConnection) {
        super()

        this.connectionId = new ConnectionID()

        socket.on('message', (message) => {
            logger.trace('ServerWebSocket::onMessage')
            if (message.type === MessageType.UTF8) {
                logger.debug('Received string Message: ' + message.utf8Data)
            } else if (message.type === MessageType.BINARY) {
                logger.trace('Received Binary Message of ' + message.binaryData.length + ' bytes')
                this.emit(ConnectionEvent.DATA,
                    new Uint8Array(message.binaryData.buffer, message.binaryData.byteOffset, 
                        message.binaryData.byteLength / Uint8Array.BYTES_PER_ELEMENT))
            }
        })
        socket.on('close', (reasonCode, description) => {
            logger.trace(' Peer ' + socket.remoteAddress + ' disconnected.')
            this.emit(ConnectionEvent.DISCONNECTED, reasonCode, description)
        })

        socket.on('error', (error) => {
            this.emit(ConnectionEvent.ERROR, error.name)
        })

        this.socket = socket
    }

    send(data: Uint8Array): void {
        if (typeof NodeJsBuffer !== 'undefined') {
            logger.trace('serverwebsocket trying to send ' + JSON.stringify(data))
            this.socket.sendBytes(NodeJsBuffer.from(data))
        } else {
            this.socket.sendBytes(Buffer.from(data))
        }
    }

    sendBufferedMessages(): void {
    }

    close(): void {
        this.socket.close()
    }

    setPeerDescriptor(peerDescriptor: PeerDescriptor): void {
        this.remotePeerDescriptor = peerDescriptor
    }

    getPeerDescriptor(): PeerDescriptor | undefined {
        return this.remotePeerDescriptor
    }

    public getRemoteAddress(): string {
        return this.socket.remoteAddress
    }

    stop(): void {
        this.removeAllListeners()
    }

    getBufferedMessages(): Uint8Array[] {
        return []
    }
}
