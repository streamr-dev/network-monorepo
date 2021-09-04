import { EventEmitter } from 'events'
import { Event, IWebRtcEndpoint } from './IWebRtcEndpoint'
import { Logger } from '../helpers/Logger'
import { PeerInfo } from './PeerInfo'
import { DeferredConnectionAttempt } from './DeferredConnectionAttempt'
import { WebRtcConnection, ConstructorOptions, isOffering } from './WebRtcConnection'
import { Metrics, MetricsContext } from '../helpers/MetricsContext'
import {
    AnswerOptions,
    ConnectOptions,
    ErrorOptions,
    OfferOptions,
    IceCandidateOptions,
    RtcSignaller
} from '../logic/RtcSignaller'
import { Rtts } from '../identifiers'
import { MessageQueue } from './MessageQueue'
import { NameDirectory } from '../NameDirectory'
import { NegotiatedProtocolVersions } from "./NegotiatedProtocolVersions"
import { v4 as uuidv4 } from 'uuid'

class WebRtcError extends Error {
    constructor(msg: string) {
        super(msg)
        // exclude this constructor from stack trace
        Error.captureStackTrace(this, WebRtcError)
    }
}

export interface WebRtcConnectionFactory {
    createConnection(opts: ConstructorOptions): WebRtcConnection
    cleanUp(): void
}

export class WebRtcEndpoint extends EventEmitter implements IWebRtcEndpoint {
    private readonly peerInfo: PeerInfo
    private readonly stunUrls: string[]
    private readonly rtcSignaller: RtcSignaller
    private readonly negotiatedProtocolVersions: NegotiatedProtocolVersions
    private readonly connectionFactory: WebRtcConnectionFactory
    private connections: { [key: string]: WebRtcConnection }
    private messageQueues: { [key: string]: MessageQueue<string> }
    private readonly newConnectionTimeout: number
    private readonly pingInterval: number
    private readonly logger: Logger
    private readonly metrics: Metrics
    private stopped = false
    private readonly bufferThresholdLow: number
    private readonly bufferThresholdHigh: number
    private readonly maxMessageSize

    constructor(
        peerInfo: PeerInfo,
        stunUrls: string[],
        rtcSignaller: RtcSignaller,
        metricsContext: MetricsContext,
        negotiatedProtocolVersions: NegotiatedProtocolVersions,
        connectionFactory: WebRtcConnectionFactory,
        newConnectionTimeout = 15000,
        pingInterval = 5 * 1000,
        webrtcDatachannelBufferThresholdLow = 2 ** 15,
        webrtcDatachannelBufferThresholdHigh = 2 ** 17,
        maxMessageSize = 1048576
    ) {
        super()
        this.peerInfo = peerInfo
        this.stunUrls = stunUrls
        this.rtcSignaller = rtcSignaller
        this.negotiatedProtocolVersions = negotiatedProtocolVersions
        this.connectionFactory = connectionFactory
        this.connections = {}
        this.messageQueues = {}
        this.newConnectionTimeout = newConnectionTimeout
        this.pingInterval = pingInterval
        this.logger = new Logger(module)
        this.bufferThresholdLow = webrtcDatachannelBufferThresholdLow
        this.bufferThresholdHigh = webrtcDatachannelBufferThresholdHigh
        this.maxMessageSize = maxMessageSize

        rtcSignaller.setOfferListener(async (options: OfferOptions) => {
            this.onRtcOfferFromSignaller(options)
        })

        rtcSignaller.setAnswerListener((options: AnswerOptions) => {
            this.onRtcAnswerFromSignaller(options)
        })

        rtcSignaller.setIceCandidateListener((options: IceCandidateOptions) => {
            this.onIceCandidateFromSignaller(options)
        })

        rtcSignaller.setConnectListener(async (options: ConnectOptions) => {
            this.onConnectFromSignaller(options)
        })

        rtcSignaller.setErrorListener((options: ErrorOptions) => {
            this.onErrorFromSignaller(options)
        })

        this.metrics = metricsContext.create('WebRtcEndpoint')
            .addRecordedMetric('inSpeed')
            .addRecordedMetric('outSpeed')
            .addRecordedMetric('msgSpeed')
            .addRecordedMetric('msgInSpeed')
            .addRecordedMetric('msgOutSpeed')
            .addRecordedMetric('open')
            .addRecordedMetric('close')
            .addRecordedMetric('sendFailed')
            .addRecordedMetric('failedConnection')
            .addQueriedMetric('connections', () => Object.keys(this.connections).length)
            .addQueriedMetric('pendingConnections', () => {
                return Object.values(this.connections).filter((c) => !c.isOpen()).length
            })
            .addQueriedMetric('totalWebSocketBuffer', () => {
                return Object.values(this.connections).reduce((total, c) => total + c.getBufferedAmount(), 0)
            })
            .addQueriedMetric('messageQueueSize', () => {
                return Object.values(this.connections).reduce((total, c) => total + c.getQueueSize(), 0)
            })
    }

    private createConnection(
        targetPeerId: string,
        routerId: string,
        deferredConnectionAttempt: DeferredConnectionAttempt | null
    ) {
        const messageQueue = this.messageQueues[targetPeerId] = this.messageQueues[targetPeerId] || new MessageQueue(this.maxMessageSize)
        const connectionOptions: ConstructorOptions = {
            selfId: this.peerInfo.peerId,
            targetPeerId,
            routerId,
            stunUrls: this.stunUrls,
            bufferThresholdHigh: this.bufferThresholdHigh,
            bufferThresholdLow: this.bufferThresholdLow,
            messageQueue,
            deferredConnectionAttempt: deferredConnectionAttempt || new DeferredConnectionAttempt(),
            newConnectionTimeout: this.newConnectionTimeout,
            pingInterval: this.pingInterval,
        }

        const connection = this.connectionFactory.createConnection(connectionOptions)

        if (connection.isOffering()) {
            connection.once('localDescription', (type, description) => {            
                this.rtcSignaller.sendRtcOffer(routerId, connection.getPeerId(), connection.getConnectionId(), description)
                this.attemptProtocolVersionValidation(connection)
            })
        } else {
            connection.once('localDescription', (type, description) => {
                this.rtcSignaller.sendRtcAnswer(routerId, connection.getPeerId(), connection.getConnectionId(), description)
                this.attemptProtocolVersionValidation(connection)
            })
        }

        connection.on('localCandidate', (candidate, mid) => {
            this.rtcSignaller.sendRtcIceCandidate(routerId, connection.getPeerId(), connection.getConnectionId(), candidate, mid)
        })
        connection.once('open', () => {
            this.emit(Event.PEER_CONNECTED, connection.getPeerInfo())
            this.metrics.record('open', 1)
        })
        connection.on('message', (message) => {
            this.emit(Event.MESSAGE_RECEIVED, connection.getPeerInfo(), message)
            this.metrics.record('inSpeed', message.length)
            this.metrics.record('msgSpeed', 1)
            this.metrics.record('msgInSpeed', 1)
        })
        connection.once('close', () => {
            if (this.connections[targetPeerId] === connection) {
                // if endpoint.close() was called, connection has already been
                // removed and possibly replaced. This check avoids deleting new
                // connection.
                delete this.connections[targetPeerId]
            }
            this.negotiatedProtocolVersions.removeNegotiatedProtocolVersion(targetPeerId)
            this.emit(Event.PEER_DISCONNECTED, connection.getPeerInfo())
            connection.removeAllListeners()
            this.metrics.record('close', 1)
        })
        connection.on('bufferLow', () => {
            this.emit(Event.LOW_BACK_PRESSURE, connection.getPeerInfo())
        })
        connection.on('bufferHigh', () => {
            this.emit(Event.HIGH_BACK_PRESSURE, connection.getPeerInfo())
        })
        connection.on('failed', () => {
            this.metrics.record('failedConnection', 1)
        })
        
        return connection
    }
    
    private onRtcOfferFromSignaller({ routerId, originatorInfo, description, connectionId }: OfferOptions): void {
        if (this.stopped) { return }

        const { peerId } = originatorInfo
        
        let connection: WebRtcConnection
       
        if (!this.connections[peerId]) {
            connection = this.createConnection(peerId, routerId,null)
            
            try {
                connection.connect()
            } catch(e) {
                this.logger.warn(e)
            }
            this.connections[peerId] = connection

        } else if (this.connections[peerId].getConnectionId() !== 'none') {
            const replacedConnection = this.replaceConnection(peerId, routerId)

            if (!replacedConnection) { return }
            connection = replacedConnection
        } else {
            connection = this.connections[peerId]
        }
        connection.setPeerInfo(PeerInfo.fromObject(originatorInfo))
        connection.setConnectionId(connectionId)
        connection.setRemoteDescription(description, 'offer')
    }

    private onRtcAnswerFromSignaller({ originatorInfo, description, connectionId }: AnswerOptions): void {
        const { peerId } = originatorInfo
        const connection = this.connections[peerId]
        if (!connection) {
            this.logger.warn('unexpected rtcAnswer from %s: %s (no connection)', peerId, description)
        } else if (connection.getConnectionId() !== connectionId) {
            this.logger.warn('unexpected rtcAnswer from %s (connectionId mismatch %s !== %s)', peerId, connection.getConnectionId(), connectionId)
        } else {
            connection.setPeerInfo(PeerInfo.fromObject(originatorInfo))
            connection.setRemoteDescription(description, 'answer')
            this.attemptProtocolVersionValidation(connection)
        }
    }

    private onIceCandidateFromSignaller({ originatorInfo, candidate, mid, connectionId }: IceCandidateOptions): void {
        const { peerId } = originatorInfo
        const connection = this.connections[peerId]
        if (!connection) { 
            this.logger.warn('unexpected iceCandidate from %s: %s (no connection)', peerId, candidate)
        } else if (connection.getConnectionId() !== connectionId) {
            this.logger.warn('unexpected iceCandidate from %s (connectionId mismatch %s !== %s)', peerId, connection.getConnectionId(), connectionId)
        } else {
            connection.addRemoteCandidate(candidate, mid)
        } 
    }
    
    private onErrorFromSignaller({ targetNode, errorCode }: ErrorOptions): void {
        const error = new WebRtcError(`RTC error ${errorCode} while attempting to signal with node ${targetNode}`)
        const connection = this.connections[targetNode]
        // treat rtcSignaller errors as connection errors.
        if (connection) {
            connection.close(error)
        }
    } 

    private onConnectFromSignaller({ originatorInfo, routerId }: ConnectOptions): void {
        const { peerId } = originatorInfo

        if (this.connections[peerId]) {
            this.replaceConnection(peerId, routerId, uuidv4())
        } else {
            this.connect(peerId, routerId, true).then(() => {
                this.logger.trace('unattended connectListener induced connection from %s connected', peerId)
                return peerId
            }).catch((err) => {
                this.logger.trace('connectListener induced connection from %s failed, reason %s', peerId, err)
            })
        }
    }

    private replaceConnection(peerId: string, routerId: string, newConnectionId?: string): WebRtcConnection | void {
        if (this.stopped) { return }

        // Close old connection
        const conn = this.connections[peerId]
        let deferredConnectionAttempt = null
        if (conn.getDeferredConnectionAttempt()) {
            deferredConnectionAttempt = conn.stealDeferredConnectionAttempt()
        }
        delete this.connections[peerId]
        conn.close()

        // Set up new connection
        const connection = this.createConnection(peerId, routerId, deferredConnectionAttempt)
        if (newConnectionId) {
            connection.setConnectionId(newConnectionId)
        }
        try {
            connection.connect()
        } catch(e) {
            this.logger.warn(e)
        }
        this.connections[peerId] = connection
        return connection
    }

    async connect(
        targetPeerId: string,
        routerId: string,
        trackerInstructed = true
    ): Promise<string> {
        // Prevent new connections from being opened when WebRtcEndpoint has been closed
        if (this.stopped) {
            return Promise.reject(new WebRtcError('WebRtcEndpoint has been stopped'))
        }

        if (this.connections[targetPeerId]) {
            const connection = this.connections[targetPeerId]
            const lastState = connection.getLastState()
            const deferredConnectionAttempt = connection.getDeferredConnectionAttempt()

            this.logger.trace('%s has already connection for %s. state: %s',
                isOffering(this.peerInfo.peerId, targetPeerId) ? 'offerer' : 'answerer',
                NameDirectory.getName(targetPeerId),
                lastState
            )
            
            if (lastState === 'connected') {
                return Promise.resolve(targetPeerId)
            } else if (deferredConnectionAttempt) {
                return deferredConnectionAttempt.getPromise()
            } else {
                throw new Error(`unexpected deferedConnectionAttempt == null ${connection.getPeerId()}`)
            }
        }
        
        const connection = this.createConnection(targetPeerId, routerId, null)

        if (connection.isOffering()) {
            connection.setConnectionId(uuidv4())
        }

        this.connections[targetPeerId] = connection
        connection.connect()
        
        if (!trackerInstructed && !connection.isOffering()) {
            // If we are non-offerer and this connection was not instructed by the tracker, we need
            // to let the offering side know about it so it can send us the initial offer message.
            
            this.rtcSignaller.sendRtcConnect(routerId, connection.getPeerId())
        }

        const deferredAttempt = connection.getDeferredConnectionAttempt()
        if (deferredAttempt) {
            return deferredAttempt.getPromise()
        } else {
            throw new Error(`disconnected ${connection.getPeerId()}`)
        }
    }

    async send(targetPeerId: string, message: string): Promise<void> {
        if (!this.connections[targetPeerId]) {
            throw new WebRtcError(`Not connected to ${targetPeerId}.`)
        }

        try {
            await this.connections[targetPeerId].send(message)
        } catch (err) {
            this.metrics.record('sendFailed', 1)
            throw err
        }

        this.metrics.record('outSpeed', message.length)
        this.metrics.record('msgSpeed', 1)
        this.metrics.record('msgOutSpeed', 1)
    }

    private attemptProtocolVersionValidation(connection: WebRtcConnection): void {
        try {
            this.negotiatedProtocolVersions.negotiateProtocolVersion(
                connection.getPeerId(),
                connection.getPeerInfo().controlLayerVersions,
                connection.getPeerInfo().messageLayerVersions
            )
        } catch (err) {
            this.logger.debug(err)
            this.close(connection.getPeerId(), `No shared protocol versions with node: ${connection.getPeerId()}`)
        }
    }

    close(receiverNodeId: string, reason: string): void {
        const connection = this.connections[receiverNodeId]
        if (connection) {
            this.logger.debug('close connection to %s due to %s', NameDirectory.getName(receiverNodeId), reason)
            delete this.connections[receiverNodeId]
            connection.close()
        }
    }

    getRtts(): Readonly<Rtts> {
        const rtts: Rtts = {}
        Object.entries(this.connections).forEach(([targetPeerId, connection]) => {
            const rtt = connection.getRtt()
            if (rtt !== undefined && rtt !== null) {
                rtts[targetPeerId] = rtt
            }
        })
        return rtts
    }

    getPeerInfo(): Readonly<PeerInfo> {
        return this.peerInfo
    }

    getNegotiatedMessageLayerProtocolVersionOnNode(peerId: string): number | undefined {
        return this.negotiatedProtocolVersions.getNegotiatedProtocolVersions(peerId)?.messageLayerVersion
    }

    getNegotiatedControlLayerProtocolVersionOnNode(peerId: string): number | undefined {
        return this.negotiatedProtocolVersions.getNegotiatedProtocolVersions(peerId)?.controlLayerVersion
    }

    getDefaultMessageLayerProtocolVersion(): number {
        return this.negotiatedProtocolVersions.getDefaultProtocolVersions().messageLayerVersion
    }

    getDefaultControlLayerProtocolVersion(): number {
        return this.negotiatedProtocolVersions.getDefaultProtocolVersions().controlLayerVersion
    }

    /**
     * @deprecated
     */
    getAddress(): string {
        return this.peerInfo.peerId
    }

    stop(): void {
        this.stopped = true
        const { connections, messageQueues } = this
        this.connections = {}
        this.messageQueues = {}
        this.rtcSignaller.setOfferListener(() => {})
        this.rtcSignaller.setAnswerListener(() => {})
        this.rtcSignaller.setIceCandidateListener(() => {})
        this.rtcSignaller.setErrorListener(() => {})
        this.rtcSignaller.setConnectListener(() => {})
        this.removeAllListeners()
        Object.values(connections).forEach((connection) => connection.close())
        Object.values(messageQueues).forEach((queue) => queue.clear())
        this.connectionFactory.cleanUp()
    }
}
