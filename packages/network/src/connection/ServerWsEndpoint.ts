import { EventEmitter } from 'events'
import { DisconnectionCode, DisconnectionReason, Event } from './IWsEndpoint'
import uWS from 'uWebSockets.js'
import { PeerBook } from './PeerBook'
import { PeerInfo, PeerType } from './PeerInfo'
import { Metrics, MetricsContext } from '../helpers/MetricsContext'
import { Logger } from '../helpers/Logger'
import { Rtts } from '../identifiers'

const staticLogger = new Logger(module)

interface Connection {
    // upgraded vars
    address?: string
    peerId?: string
    peerType?: PeerType
    controlLayerVersions?: string
    messageLayerVersions?: string

    peerInfo: PeerInfo
    highBackPressure: boolean
    respondedPong?: boolean
    rttStart?: number
    rtt?: number
}

interface UWSConnection extends uWS.WebSocket, Connection {}

const HIGH_BACK_PRESSURE = 1024 * 1024 * 2
const LOW_BACK_PRESSURE = 1024 * 1024
const WS_BUFFER_SIZE = HIGH_BACK_PRESSURE + 1024 // add 1 MB safety margin

function ab2str (buf: ArrayBuffer | SharedArrayBuffer): string {
    return Buffer.from(buf).toString('utf8')
}

function closeWs(
    ws: UWSConnection,
    code: DisconnectionCode,
    reason: DisconnectionReason,
    logger: Logger
): void {
    try {
        ws.end(code, reason)
    } catch (e) {
        logger.error('failed to close ws, reason: %s', e)
    }
}

function getBufferedAmount(ws: UWSConnection): number {
    return ws.getBufferedAmount()
}

function terminateWs(ws: UWSConnection, logger: Logger): void {
    try {
        ws.close()
    } catch (e) {
        logger.error('failed to terminate ws, reason %s', e)
    }
}

export class ServerWsEndpoint extends EventEmitter {
    private readonly serverHost: string
    private readonly serverPort: number
    private readonly wss: uWS.TemplatedApp
    private listenSocket: uWS.us_listen_socket | null
    private readonly peerInfo: PeerInfo
    private readonly advertisedWsUrl: string | null

    private readonly logger: Logger
    private readonly connections: Map<string, UWSConnection>
    private readonly pendingConnections: Map<string, Promise<string>>
    private readonly peerBook: PeerBook
    private readonly pingInterval: NodeJS.Timeout
    private readonly metrics: Metrics

    constructor(
        host: string,
        port: number,
        wss: uWS.TemplatedApp,
        listenSocket: uWS.us_listen_socket,
        peerInfo: PeerInfo,
        advertisedWsUrl: string | null,
        metricsContext = new MetricsContext(peerInfo.peerId),
        pingInterval = 5 * 1000
    ) {
        super()

        if (!wss) {
            throw new Error('wss not given')
        }
        if (!(peerInfo instanceof PeerInfo)) {
            throw new Error('peerInfo not instance of PeerInfo')
        }
        if (advertisedWsUrl === undefined) {
            throw new Error('advertisedWsUrl not given')
        }

        this.serverHost = host
        this.serverPort = port
        this.wss = wss
        this.listenSocket = listenSocket
        this.peerInfo = peerInfo
        this.advertisedWsUrl = advertisedWsUrl

        this.logger = new Logger(module)
        this.connections = new Map()
        this.pendingConnections = new Map()
        this.peerBook = new PeerBook()

        this.wss.ws('/ws', {
            compression: 0,
            maxPayloadLength: 1024 * 1024,
            maxBackpressure: WS_BUFFER_SIZE,
            idleTimeout: 0,
            upgrade: (res, req, context) => {
                res.writeStatus('101 Switching Protocols')
                    .writeHeader('streamr-peer-id', this.peerInfo.peerId)
                    .writeHeader('streamr-peer-type', this.peerInfo.peerType)
                    .writeHeader('control-layer-versions', this.peerInfo.controlLayerVersions.join(','))
                    .writeHeader('message-layer-versions', this.peerInfo.messageLayerVersions.join(','))

                /* This immediately calls open handler, you must not use res after this call */
                res.upgrade({
                    address: req.getQuery('address'),
                    peerId: req.getHeader('streamr-peer-id'),
                    peerType: req.getHeader('streamr-peer-type'),
                    controlLayerVersions: req.getHeader('control-layer-versions'),
                    messageLayerVersions: req.getHeader('message-layer-versions')
                },
                /* Spell these correctly */
                req.getHeader('sec-websocket-key'),
                req.getHeader('sec-websocket-protocol'),
                req.getHeader('sec-websocket-extensions'),
                context)
            },
            open: (ws) => {
                this.onIncomingConnection(ws as UWSConnection)
            },
            message: (ws, message, _isBinary) => {
                const connection = this.connections.get(ws.address)

                if (connection) {
                    this.onReceive(ws.peerInfo, ws.address, ab2str(message))
                }
            },
            drain: (ws) => {
                this.evaluateBackPressure(ws as UWSConnection)
            },
            close: (ws, code, message) => {
                const reason = ab2str(message)

                const connection = this.connections.get(ws.address)

                if (connection) {
                    // added 'close' event for test - duplicate-connections-are-closed.test.js
                    this.emit('close', ws, code, reason)
                    this.onClose(ws.address, this.peerBook.getPeerInfo(ws.address)!, code, reason)
                }
            },
            pong: (ws) => {
                const connection = this.connections.get(ws.address)

                if (connection) {
                    this.logger.trace('<== received from %s "pong" frame', ws.address)
                    connection.respondedPong = true
                    connection.rtt = Date.now() - connection.rttStart!
                }
            }
        })

        this.logger.trace('listening on %s', this.getAddress())
        this.pingInterval = setInterval(() => this.pingConnections(), pingInterval)

        this.metrics = metricsContext.create('WsEndpoint')
            .addRecordedMetric('inSpeed')
            .addRecordedMetric('outSpeed')
            .addRecordedMetric('msgSpeed')
            .addRecordedMetric('msgInSpeed')
            .addRecordedMetric('msgOutSpeed')
            .addRecordedMetric('open')
            .addRecordedMetric('open:duplicateSocket')
            .addRecordedMetric('open:failedException')
            .addRecordedMetric('open:headersNotReceived')
            .addRecordedMetric('open:missingParameter')
            .addRecordedMetric('open:ownAddress')
            .addRecordedMetric('close')
            .addRecordedMetric('sendFailed')
            .addRecordedMetric('webSocketError')
            .addQueriedMetric('connections', () => this.connections.size)
            .addQueriedMetric('pendingConnections', () => this.pendingConnections.size)
            .addQueriedMetric('rtts', () => this.getRtts())
            .addQueriedMetric('totalWebSocketBuffer', () => {
                return [...this.connections.values()]
                    .reduce((totalBufferSizeSum, ws) => totalBufferSizeSum + getBufferedAmount(ws), 0)
            })
    }

    private pingConnections(): void {
        const addresses = [...this.connections.keys()]
        addresses.forEach((address) => {
            const ws = this.connections.get(address)!

            try {
                // didn't get "pong" in pingInterval
                if (ws.respondedPong !== undefined && !ws.respondedPong) {
                    throw new Error('ws is not active')
                }

                // eslint-disable-next-line no-param-reassign
                ws.respondedPong = false
                ws.rttStart = Date.now()
                ws.ping()
                this.logger.trace('pinging %s (current rtt %s)', address, ws.rtt)
            } catch (e) {
                this.logger.warn(`failed pinging %s, error %s, terminating connection`, address, e)
                terminateWs(ws, this.logger)
                this.onClose(
                    address,
                    this.peerBook.getPeerInfo(address)!,
                    DisconnectionCode.DEAD_CONNECTION,
                    DisconnectionReason.DEAD_CONNECTION
                )
            }
        })
    }

    send(recipientId: string, message: string): Promise<string> {
        const recipientAddress = this.resolveAddress(recipientId)
        return new Promise<string>((resolve, reject) => {
            if (!this.isConnected(recipientAddress)) {
                this.metrics.record('sendFailed', 1)
                this.logger.trace('cannot send to %s [%s], not connected', recipientId, recipientAddress)
                reject(new Error(`cannot send to ${recipientId} [${recipientAddress}] because not connected`))
            } else {
                const ws = this.connections.get(recipientAddress)!
                this.socketSend(ws, message, recipientId, recipientAddress, resolve, reject)
            }
        })
    }

    private socketSend(
        ws: UWSConnection,
        message: string,
        recipientId: string,
        recipientAddress: string,
        successCallback: (peerId: string) => void,
        errorCallback: (err: Error) => void
    ): void {
        const onSuccess = (address: string, peerId: string, msg: string): void => {
            this.logger.trace('sent to %s [%s] message "%s"', recipientId, address, msg)
            this.metrics.record('outSpeed', msg.length)
            this.metrics.record('msgSpeed', 1)
            this.metrics.record('msgOutSpeed', 1)
            successCallback(peerId)
        }

        try {
            ws.send(message)
            onSuccess(recipientAddress, recipientId, message)
            this.evaluateBackPressure(ws)
        } catch (e) {
            this.metrics.record('sendFailed', 1)
            this.logger.warn('sending to %s [%s] failed, reason %s, readyState is %s',
                recipientId, recipientAddress, e, ws.readyState)
            errorCallback(e)
            terminateWs(ws, this.logger)
        }
    }

    private evaluateBackPressure(ws: UWSConnection): void {
        const bufferedAmount = getBufferedAmount(ws)
        if (!ws.highBackPressure && bufferedAmount > HIGH_BACK_PRESSURE) {
            this.logger.trace('Back pressure HIGH for %s at %d', ws.peerInfo, bufferedAmount)
            this.emit(Event.HIGH_BACK_PRESSURE, ws.peerInfo)
            ws.highBackPressure = true
        } else if (ws.highBackPressure && bufferedAmount < LOW_BACK_PRESSURE) {
            this.logger.trace('Back pressure LOW for %s at %d', ws.peerInfo, bufferedAmount)
            this.emit(Event.LOW_BACK_PRESSURE, ws.peerInfo)
            ws.highBackPressure = false
        }
    }

    private onReceive(peerInfo: PeerInfo, address: string, message: string): void {
        this.logger.trace('<== received from %s [%s] message "%s"', peerInfo, address, message)
        this.emit(Event.MESSAGE_RECEIVED, peerInfo, message)
    }

    close(recipientId: string, reason = DisconnectionReason.GRACEFUL_SHUTDOWN): void {
        const recipientAddress = this.resolveAddress(recipientId)

        this.metrics.record('close', 1)
        if (!this.isConnected(recipientAddress)) {
            this.logger.trace('cannot close connection to %s [%s] because not connected', recipientId, recipientAddress)
        } else {
            const ws = this.connections.get(recipientAddress)!
            try {
                this.logger.trace('closing connection to %s [%s], reason %s', recipientId, recipientAddress, reason)
                closeWs(ws, DisconnectionCode.GRACEFUL_SHUTDOWN, reason, this.logger)
            } catch (e) {
                this.logger.warn('closing connection to %s [%s] failed because of %s', recipientId, recipientAddress, e)
            }
        }
    }

    stop(): Promise<void> {
        clearInterval(this.pingInterval)

        return new Promise<void>((resolve, reject) => {
            try {
                this.connections.forEach((ws) => {
                    closeWs(ws, DisconnectionCode.GRACEFUL_SHUTDOWN, DisconnectionReason.GRACEFUL_SHUTDOWN, this.logger)
                })

                if (this.listenSocket) {
                    this.logger.trace('shutting down uWS server')
                    uWS.us_listen_socket_close(this.listenSocket)
                    this.listenSocket = null
                }

                setTimeout(() => resolve(), 100)
            } catch (e) {
                this.logger.error('error while shutting down uWS server: %s', e)
                reject(new Error(`Failed to stop websocket server, because of ${e}`))
            }
        })
    }

    isConnected(address: string): boolean {
        return this.connections.has(address)
    }

    getRtts(): Rtts {
        const connections = [...this.connections.keys()]
        const rtts: Rtts = {}
        connections.forEach((address) => {
            const { rtt } = this.connections.get(address)!
            const nodeId = this.peerBook.getPeerId(address)
            if (rtt !== undefined && rtt !== null) {
                rtts[nodeId] = rtt
            }
        })
        return rtts
    }

    getAddress(): string {
        if (this.advertisedWsUrl) {
            return this.advertisedWsUrl
        }
        return `ws://${this.serverHost}:${this.serverPort}`
    }

    getWss(): uWS.TemplatedApp {
        return this.wss
    }

    getPeerInfo(): Readonly<PeerInfo> {
        return this.peerInfo
    }

    getPeers(): ReadonlyMap<string, UWSConnection> {
        return this.connections
    }

    getPeerInfos(): PeerInfo[] {
        return Array.from(this.connections.keys())
            .map((address) => this.peerBook.getPeerInfo(address))
            .filter((x) => x !== null) as PeerInfo[]
    }

    resolveAddress(peerId: string): string | never {
        return this.peerBook.getAddress(peerId)
    }

    private onIncomingConnection(ws: UWSConnection): void {
        const { address, peerId, peerType, controlLayerVersions, messageLayerVersions } = ws

        try {
            if (!address) {
                throw new Error('address not given')
            }
            if (!peerId) {
                throw new Error('peerId not given')
            }
            if (!peerType) {
                throw new Error('peerType not given')
            }
            if (!controlLayerVersions) {
                throw new Error('controlLayerVersions not given')
            }
            if (!messageLayerVersions) {
                throw new Error('messageLayerVersions not given')
            }
            const controlLayerVersionsArray = controlLayerVersions.split(',').map((version) => parseInt(version))
            const messageLayerVersionsArray = messageLayerVersions.split(',').map((version) => parseInt(version))

            const clientPeerInfo = new PeerInfo(peerId, peerType, controlLayerVersionsArray, messageLayerVersionsArray)
            if (this.isConnected(address)) {
                this.metrics.record('open:duplicateSocket', 1)
                ws.close()
                return
            }

            this.logger.trace('<=== %s connecting to me', address)
            this.onNewConnection(ws, address, clientPeerInfo, false)
        } catch (e) {
            this.logger.trace('dropped incoming connection because of %s', e)
            this.metrics.record('open:missingParameter', 1)
            closeWs(ws, DisconnectionCode.MISSING_REQUIRED_PARAMETER, e.toString(), this.logger)
        }
    }

    private onClose(address: string, peerInfo: PeerInfo, code = 0, reason = ''): void {
        if (reason === DisconnectionReason.DUPLICATE_SOCKET) {
            this.metrics.record('open:duplicateSocket', 1)
            this.logger.trace('socket %s dropped from other side because existing connection already exists')
            return
        }

        this.metrics.record('close', 1)
        this.logger.trace('socket to %s closed (code %d, reason %s)', address, code, reason)
        this.connections.delete(address)
        this.logger.trace('removed %s [%s] from connection list', peerInfo, address)
        this.emit(Event.PEER_DISCONNECTED, peerInfo, reason)
    }

    private onNewConnection(
        ws: UWSConnection,
        address: string,
        peerInfo: PeerInfo, out: boolean
    ): boolean {
        // Handle scenario where two peers have opened a socket to each other at the same time.
        // Second condition is a tiebreaker to avoid both peers of simultaneously disconnecting their socket,
        // thereby leaving no connection behind.
        if (this.isConnected(address) && this.getAddress().localeCompare(address) === 1) {
            this.metrics.record('open:duplicateSocket', 1)
            this.logger.trace('dropped new connection with %s because an existing connection already exists', address)
            closeWs(ws, DisconnectionCode.DUPLICATE_SOCKET, DisconnectionReason.DUPLICATE_SOCKET, this.logger)
            return false
        }

        // eslint-disable-next-line no-param-reassign
        ws.peerInfo = peerInfo
        // eslint-disable-next-line no-param-reassign
        ws.address = address
        this.peerBook.add(address, peerInfo)
        this.connections.set(address, ws)
        this.metrics.record('open', 1)
        this.logger.trace('added %s [%s] to connection list', peerInfo, address)
        this.logger.trace('%s connected to %s', out ? '===>' : '<===', address)
        this.emit(Event.PEER_CONNECTED, peerInfo)

        return true
    }

}

export function startWebSocketServer(
    host: string | null,
    port: number,
    privateKeyFileName: string | undefined = undefined,
    certFileName: string | undefined = undefined
): Promise<[uWS.TemplatedApp, any]> {
    return new Promise((resolve, reject) => {
        let server: uWS.TemplatedApp
        if (privateKeyFileName && certFileName) {
            staticLogger.trace(`starting SSL uWS server (host: ${host}, port: ${port}, using ${privateKeyFileName}, ${certFileName}`)
            server = uWS.SSLApp({
                key_file_name: privateKeyFileName,
                cert_file_name: certFileName,
            })
        } else {
            staticLogger.trace(`starting non-SSL uWS (host: ${host}, port: ${port}`)
            server = uWS.App()
        }

        const cb = (listenSocket: uWS.us_listen_socket): void => {
            if (listenSocket) {
                resolve([server, listenSocket])
            } else {
                reject(new Error(`Failed to start websocket server, host ${host}, port ${port}`))
            }
        }

        if (host) {
            server.listen(host, port, cb)
        } else {
            server.listen(port, cb)
        }
    })
}

export async function startServerWsEndpoint(
    host: string,
    port: number,
    peerInfo: PeerInfo,
    advertisedWsUrl: string | null,
    metricsContext?: MetricsContext,
    pingInterval?: number | undefined,
    privateKeyFileName?: string | undefined,
    certFileName?: string | undefined,
): Promise<ServerWsEndpoint> {
    return startWebSocketServer(host, port, privateKeyFileName, certFileName).then(([wss, listenSocket]) => {
        return new ServerWsEndpoint(host, port, wss, listenSocket, peerInfo, advertisedWsUrl, metricsContext, pingInterval)
    })
}