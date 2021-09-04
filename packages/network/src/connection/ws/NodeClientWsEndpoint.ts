import WebSocket from 'ws'
import { PeerInfo } from '../PeerInfo'
import { MetricsContext } from '../../helpers/MetricsContext'
import { DisconnectionReason } from "./AbstractWsEndpoint"
import { NodeClientWsConnection, NodeWebSocketConnectionFactory } from './NodeClientWsConnection'
import { AbstractClientWsEndpoint, HandshakeValues, PeerId, ServerUrl } from "./AbstractClientWsEndpoint"

export default class NodeClientWsEndpoint extends AbstractClientWsEndpoint<NodeClientWsConnection> {
    constructor(
        peerInfo: PeerInfo,
        metricsContext?: MetricsContext,
        pingInterval?: number
    ) {
        super(peerInfo, metricsContext, pingInterval)
    }

    protected doConnect(serverUrl: ServerUrl, serverPeerInfo: PeerInfo): Promise<PeerId> {
        return new Promise<string>((resolve, reject) => {
            try {
                const ws = new WebSocket(`${serverUrl}/ws`)

                ws.once('open', () => {
                    this.handshakeInit(ws, serverPeerInfo, reject)
                })

                const onMessage = (message: string | Buffer | Buffer[]) => {
                    const didHandshake = this.handshakeListener(ws, serverPeerInfo, serverUrl, message, resolve)
                    if (didHandshake) {
                        ws.off('message', onMessage)
                        ws.off('error', onError)
                        ws.off('close', onClose)
                    }
                }
                ws.on('message', onMessage)

                const onClose = (code: number, reason: string): void => {
                    this.onHandshakeClosed(serverUrl, code, reason, reject)
                }

                ws.on('close', onClose)

                const onError = (err: Error) => {
                    this.onHandshakeError(serverUrl, err, reject)
                }

                ws.on('error', onError)
            } catch (err) {
                this.metrics.record('open:failedException', 1)
                this.logger.trace('failed to connect to %s, error: %o', serverUrl, err)
                reject(err)
            }
        })
    }

    protected doSetUpConnection(ws: WebSocket, serverPeerInfo: PeerInfo): NodeClientWsConnection {
        const connection = NodeWebSocketConnectionFactory.createConnection(ws, serverPeerInfo)

        ws.on('message', (message: string | Buffer | Buffer[]) => {
            this.onReceive(connection, message.toString())
        })
        ws.on('pong', () => {
            connection.onPong()
        })
        ws.once('close', (code: number, reason: string): void => {
            this.onClose(connection, code, reason as DisconnectionReason)
        })

        ws.on('error', (err) => {
            this.ongoingConnectionError(serverPeerInfo.peerId, err, connection)
        })

        return connection
    }

    protected doHandshakeResponse(uuid: string, peerId: string, ws: WebSocket): void {
        ws.send(JSON.stringify({ uuid, peerId: this.peerInfo.peerId }))
    }

    protected doHandshakeParse(message: string | Buffer | Buffer[]): HandshakeValues {
        const { uuid, peerId } = JSON.parse(message.toString())
        return {
            uuid,
            peerId
        }
    }
}
