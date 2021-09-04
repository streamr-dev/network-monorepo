import { PeerInfo } from '../PeerInfo'
import { MetricsContext } from '../../helpers/MetricsContext'
import { AbstractWsEndpoint, DisconnectionCode, DisconnectionReason, } from "./AbstractWsEndpoint"
import { staticLogger, ServerWsConnection } from './ServerWsConnection'
import fs from 'fs'
import https from 'https'
import http from 'http'
import WebSocket from 'ws'
import { once } from 'events'
import { v4 } from 'uuid'
import { Duplex } from "stream"

export class ServerWsEndpoint extends AbstractWsEndpoint<ServerWsConnection> {
    private readonly serverUrl: string
    private readonly httpServer: http.Server | https.Server
    private readonly wss: WebSocket.Server
    constructor(
        host: string,
        port: number,
        sslEnabled: boolean,
        httpServer: http.Server | https.Server,
        peerInfo: PeerInfo,
        metricsContext?: MetricsContext,
        pingInterval?: number
    ) {
        super(peerInfo, metricsContext, pingInterval)

        this.httpServer = httpServer
        this.serverUrl = `${sslEnabled ? 'wss' : 'ws'}://${host}:${port}`
        this.wss = this.startWsServer()
    }

    private startWsServer(): WebSocket.Server {
        return new WebSocket.Server({
            server: this.httpServer,
            maxPayload: 1024 * 1024
        }).on('error', (err: Error) => {
            this.logger.error('web socket server (wss) emitted error: %s', err)
        }).on('listening', () => {
            this.logger.trace('listening on %s', this.getUrl())
        }).on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
            const handshakeUUID = v4()

            ws.send(JSON.stringify({ uuid: handshakeUUID, peerId: this.peerInfo.peerId }))

            this.handshakeTimeoutRefs[handshakeUUID] = setTimeout(() => {
                ws.close(DisconnectionCode.FAILED_HANDSHAKE, `Handshake not received from connection behind UUID ${handshakeUUID}`)
                this.logger.warn(`Handshake not received from connection behind UUID ${handshakeUUID}`)
                ws.terminate()
                delete this.handshakeTimeoutRefs[handshakeUUID]
            }, this.handshakeTimer)

            const duplexStream = WebSocket.createWebSocketStream(ws, {
                decodeStrings: false
            })

            let otherNodeIdForLogging = 'unknown (no handshake)'

            const onData = async (data: WebSocket.Data) => {
                try {
                    const { uuid, peerId } = JSON.parse(data.toString())
                    if (uuid === handshakeUUID && peerId) {
                        otherNodeIdForLogging = peerId
                        // remove handler
                        duplexStream.off('data', onData)
                        this.clearHandshake(uuid)
                        this.acceptConnection(ws, duplexStream, peerId, this.resolveIP(request))
                    } else {
                        this.logger.trace('Expected a handshake message from %s got: %o ', this.peerInfo.peerId, data.toString())
                    }
                } catch (err) {
                    this.logger.trace(err)
                }
            }

            duplexStream.on('data', onData)

            ws.on('error', (err) => {
                this.logger.warn('socket for "%s" emitted error: %s', otherNodeIdForLogging, err)
            })
        })
    }

    acceptConnection(ws: WebSocket, duplexStream: Duplex, peerId: string, remoteAddress: string): void {
        const connection = new ServerWsConnection(
            ws,
            duplexStream,
            remoteAddress,
            PeerInfo.newNode(peerId)
        )

        duplexStream.on('data', async (data: WebSocket.Data) => {
            const parsed = data.toString()
            if (parsed === 'ping') {
                await this.send(peerId, 'pong')
            } else {
                this.onReceive(connection, data.toString())
            }
        })

        duplexStream.on('drain', () => {
            connection.evaluateBackPressure()
        })

        duplexStream.on('error', (error) => {
            this.logger.error('Duplex stream error: ' + error.stack as string)
        })

        ws.on('pong', () => {
            connection.onPong()
        })

        ws.on('close', (code: number, reason: string) => {
            this.onClose(connection, code, reason as DisconnectionReason)
        })

        this.onNewConnection(connection)
    }

    getUrl(): string {
        return this.serverUrl
    }

    resolveAddress(peerId: string): string | undefined {
        return this.getConnectionByPeerId(peerId)?.getRemoteAddress()
    }

    protected doClose(_connection: ServerWsConnection, _code: DisconnectionCode, _reason: DisconnectionReason): void {}

    protected async doStop(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.wss.close((err?) => {
                if (err) {
                    this.logger.error('error on closing websocket server: %s', err)
                }
                this.httpServer.close((err?) => {
                    if (err) {
                        this.logger.error('error closing http server: %s', err)
                        reject(err)
                    } else {
                        resolve()
                    }
                })
            })
        })
    }

    private resolveIP(request: http.IncomingMessage): string {
        // Accept X-Forwarded-For header on connections from the local machine
        if (request.socket.remoteAddress?.endsWith('127.0.0.1')) {
            return (request.headers['x-forwarded-for'] || request.socket.remoteAddress) as string
        }
        return request.socket.remoteAddress as string
    }
}

export async function startHttpServer(
    host: string | null,
    port: number,
    privateKeyFileName: string | undefined = undefined,
    certFileName: string | undefined = undefined
): Promise<http.Server | https.Server> {
    let httpServer: http.Server | https.Server
    if (privateKeyFileName && certFileName) {
        const opts = {
            key: fs.readFileSync(privateKeyFileName),
            cert: fs.readFileSync(certFileName)
        }
        httpServer = https.createServer(opts)
    } else if (privateKeyFileName === undefined && certFileName === undefined) {
        httpServer = http.createServer()
    } else {
        throw new Error('must supply both privateKeyFileName and certFileName or neither')
    }

    httpServer.listen(port)
    await once(httpServer, 'listening')
    staticLogger.trace(`started on port %s`, port)
    return httpServer
}
