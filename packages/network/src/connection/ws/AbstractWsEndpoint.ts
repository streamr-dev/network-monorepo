import { EventEmitter } from "events"
import { Logger } from "../../helpers/Logger"
import { PeerInfo } from "../PeerInfo"
import { Metrics, MetricsContext } from "../../helpers/MetricsContext"
import { Rtts } from "../../identifiers"
import { PingPongWs } from "./PingPongWs"
import { AbstractWsConnection } from './AbstractWsConnection'

export enum Event {
    PEER_CONNECTED = 'streamr:peer:connect',
    PEER_DISCONNECTED = 'streamr:peer:disconnect',
    MESSAGE_RECEIVED = 'streamr:message-received',
    HIGH_BACK_PRESSURE = 'streamr:high-back-pressure',
    LOW_BACK_PRESSURE = 'streamr:low-back-pressure'
}

export enum DisconnectionCode {
    GRACEFUL_SHUTDOWN = 1000,
    FAILED_HANDSHAKE = 4000,
    DEAD_CONNECTION = 4001
}

export enum DisconnectionReason {
    GRACEFUL_SHUTDOWN = 'streamr:node:graceful-shutdown',
    DUPLICATE_SOCKET = 'streamr:endpoint:duplicate-connection',
    NO_SHARED_STREAMS = 'streamr:node:no-shared-streams',
    DEAD_CONNECTION = 'dead connection'
}

export class UnknownPeerError extends Error {
    static CODE = 'UnknownPeerError'
    readonly code = UnknownPeerError.CODE

    constructor(msg: string) {
        super(msg)
        Error.captureStackTrace(this, UnknownPeerError)
    }
}

export abstract class AbstractWsEndpoint<C extends AbstractWsConnection> extends EventEmitter {
    private readonly pingPongWs: PingPongWs
    private readonly connectionById: Map<string, C> = new Map<string, C>()
    private stopped = false

    protected handshakeTimeoutRefs: { [key: string]: NodeJS.Timeout }
    protected readonly metrics: Metrics
    protected readonly peerInfo: PeerInfo
    protected readonly logger: Logger
    protected readonly handshakeTimer: number

    protected constructor(
        peerInfo: PeerInfo,
        metricsContext: MetricsContext = new MetricsContext(peerInfo.peerId),
        pingInterval = 60 * 1000
    ) {
        super()

        this.peerInfo = peerInfo
        this.logger = new Logger(this)
        this.pingPongWs = new PingPongWs(() => this.getConnections(), pingInterval)
        this.handshakeTimeoutRefs = {}
        this.handshakeTimer = 15 * 1000

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
            .addQueriedMetric('connections', () => this.getConnections().length)
            .addQueriedMetric('rtts', () => this.getRtts())
            .addQueriedMetric('totalWebSocketBuffer', () => {
                return this.getConnections()
                    .reduce((sum, connection) => sum + connection.getBufferedAmount(), 0)
            })
    }

    async send(recipientId: string, message: string): Promise<void> {
        if (this.stopped) {
            return
        }
        const connection = this.getConnectionByPeerId(recipientId)
        if (connection !== undefined) {
            try {
                connection.evaluateBackPressure()
                await connection.send(message)
            } catch (err) {
                this.metrics.record('sendFailed', 1)
                this.logger.debug('sending to %s failed, reason %s', recipientId, err)
                connection.terminate()
                throw err
            }

            this.logger.trace('sent to %s message "%s"', recipientId, message)
            this.metrics.record('outSpeed', message.length)
            this.metrics.record('msgSpeed', 1)
            this.metrics.record('msgOutSpeed', 1)
        } else {
            this.metrics.record('sendFailed', 1)
            this.logger.trace('cannot send to %s, not connected', recipientId)
            throw new UnknownPeerError(`cannot send to ${recipientId} because not connected`)
        }
    }

    close(recipientId: string, code: DisconnectionCode, reason: DisconnectionReason): void {
        const connection = this.getConnectionByPeerId(recipientId)
        if (connection !== undefined) {
            this.metrics.record('close', 1)
            try {
                this.logger.trace('closing connection to %s, reason %s', recipientId, reason)
                connection.close(code, reason)
            } catch (e) {
                this.logger.warn('closing connection to %s failed because of %s', recipientId, e)
            }
        }
    }

    stop(): Promise<void> {
        this.stopped = true
        this.pingPongWs.stop()
        Object.keys(this.handshakeTimeoutRefs).map((id) => {
            this.clearHandshake(id)
        })
        this.handshakeTimeoutRefs = {}
        return this.doStop()
    }

    getRtts(): Rtts {
        return this.pingPongWs.getRtts()
    }

    getPeers(): ReadonlyMap<string, C> {
        return this.connectionById
    }

    getPeerInfos(): PeerInfo[] {
        return this.getConnections().map((connection) => connection.getPeerInfo())
    }

    clearHandshake(id: string): void {
        if (this.handshakeTimeoutRefs[id]) {
            clearTimeout(this.handshakeTimeoutRefs[id])
            delete this.handshakeTimeoutRefs[id]
        }
    }

    /**
     * Custom close logic of subclass
     */
    protected abstract doClose(connection: C, code: DisconnectionCode, reason: DisconnectionReason): void

    /**
     * Custom clean up logic of subclass
     */
    protected abstract doStop(): Promise<void>

    /**
     * Implementer should invoke this whenever a new connection is formed
     */
    protected onNewConnection(connection: C): void {
        if (this.stopped) {
            return
        }
        const peerInfo = connection.getPeerInfo()
        connection.setBackPressureHandlers(
            () =>  {
                this.emitLowBackPressure(peerInfo)
            },
            () =>  {
                this.emitHighBackPressure(peerInfo)
            }
        )
        if (this.connectionById.get(connection.getPeerId())) {
            this.logger.warn('new connection to %s? %s', connection.getPeerId(), !!this.connectionById.get(connection.getPeerId()))
        }
        this.connectionById.set(connection.getPeerId(), connection)
        this.metrics.record('open', 1)
        this.logger.trace('added %s to connection list', connection.getPeerId())
        this.emit(Event.PEER_CONNECTED, peerInfo)
    }

    /**
     * Implementer should invoke this whenever a message is received.
     */
    protected onReceive(connection: AbstractWsConnection, message: string): void {
        if (this.stopped) {
            return
        }
        this.metrics.record('inSpeed', message.length)
        this.metrics.record('msgSpeed', 1)
        this.metrics.record('msgInSpeed', 1)
        this.logger.trace('<== received from %s message "%s"', connection.getPeerInfo(), message)
        this.emit(Event.MESSAGE_RECEIVED, connection.getPeerInfo(), message)
    }

    /**
     * Implementer should invoke this whenever a connection is closed.
     */
    protected onClose(connection: C, code: DisconnectionCode, reason: DisconnectionReason): void {
        if (reason === DisconnectionReason.DUPLICATE_SOCKET) {
            this.metrics.record('open:duplicateSocket', 1)
        }
        this.metrics.record('close', 1)
        this.logger.trace('socket to %s closed (code %d, reason %s)', connection.getPeerId(), code, reason)
        this.connectionById.delete(connection.getPeerId())
        try {
            this.doClose(connection, code, reason)
        } finally {
            this.emit(Event.PEER_DISCONNECTED, connection.getPeerInfo(), reason)
        }
    }

    protected getConnections(): C[] {
        return [...this.connectionById.values()]
    }

    protected getConnectionByPeerId(peerId: string): C | undefined {
        return this.connectionById.get(peerId)
    }

    private emitLowBackPressure(peerInfo: PeerInfo): void {
        this.emit(Event.LOW_BACK_PRESSURE, peerInfo)
    }

    private emitHighBackPressure(peerInfo: PeerInfo): void {
        this.emit(Event.HIGH_BACK_PRESSURE, peerInfo)
    }
}
