import { IWebRtcConnection, Event as IWebRtcEvent } from './IWebRtcConnection'
import { ConnectionType, IConnection, ConnectionID, Event as ConnectionEvent, } from '../IConnection'
import { PeerDescriptor } from '../../proto/DhtRpc'
import EventEmitter from 'events'
import nodeDatachannel, { DataChannel, DescriptionType, PeerConnection } from 'node-datachannel'
import { PeerID } from '../../helpers/PeerID'
import { IWebRtcCleanUp } from './IWebRtcCleanUp'
import { Logger } from '@streamr/utils'
import { IllegalRTCPeerConnectionState } from '../../helpers/errors'

const logger = new Logger(module)

const MAX_MESSAGE_SIZE = 1048576

export const WEB_RTC_CLEANUP = new class implements IWebRtcCleanUp {
    cleanUp(): void {
        nodeDatachannel.cleanup()
    }
}

export interface Params {
    remotePeerDescriptor: PeerDescriptor
    bufferThresholdHigh?: number
    bufferThresholdLow?: number
    connectingTimeout?: number
    stunUrls?: string[]
}

// Re-defined accoring to https://github.com/microsoft/TypeScript/blob/main/src/lib/dom.generated.d.ts
// because importing single dom definitions in not possible

enum RTCPeerConnectionStateEnum {closed, connected, connecting, disconnected, failed,  new}
type RTCPeerConnectionState = keyof typeof RTCPeerConnectionStateEnum  

export class NodeWebRtcConnection extends EventEmitter implements IConnection, IWebRtcConnection {

    public connectionId: ConnectionID
    public connectionType: ConnectionType = ConnectionType.WEBRTC
    private connection?: PeerConnection
    private dataChannel?: DataChannel
    private stunUrls: string[]
    private bufferThresholdHigh: number // TODO: buffer handling must be implemented before production use
    private bufferThresholdLow: number
    private lastState: RTCPeerConnectionState = 'connecting'
    private buffer: Uint8Array[] = []
    private remoteDescriptionSet = false
    private connectingTimeoutRef: NodeJS.Timeout | null = null
    private connectingTimeout: number
    private remotePeerDescriptor: PeerDescriptor
    
    constructor(params: Params) {
        super()
        this.connectionId = new ConnectionID()
        this.stunUrls = params.stunUrls || []
        this.bufferThresholdHigh = params.bufferThresholdHigh || 2 ** 17
        this.bufferThresholdLow = params.bufferThresholdLow || 2 ** 15
        this.connectingTimeout = params.connectingTimeout || 10000
        this.remotePeerDescriptor = params.remotePeerDescriptor
    }

    start(isOffering: boolean): void {
        logger.trace(`Staring new connection for peer: ${this.remotePeerDescriptor.peerId.toString()}`)
        const hexId = PeerID.fromValue(this.remotePeerDescriptor.peerId).toMapKey()
        this.connection = new PeerConnection(hexId, {
            iceServers: [...this.stunUrls],
            maxMessageSize: MAX_MESSAGE_SIZE
        })

        this.connectingTimeoutRef = setTimeout(() => {
            this.close()
        }, this.connectingTimeout)

        this.connection.onStateChange((state) => this.onStateChange(state))
        this.connection.onGatheringStateChange((_state) => {})
        this.connection.onLocalDescription((description: string, type: DescriptionType) => {
            this.emit(IWebRtcEvent.LOCAL_DESCRIPTION, description, type.toString())
        })
        this.connection.onLocalCandidate((candidate: string, mid: string) => {
            this.emit(IWebRtcEvent.LOCAL_CANDIDATE, candidate, mid)
        })
        if (isOffering) {
            const dataChannel = this.connection.createDataChannel('streamrDataChannel')
            this.setupDataChannel(dataChannel)
        } else {
            this.connection.onDataChannel((dataChannel) => this.onDataChannel(dataChannel))
        }
    }

    async setRemoteDescription(description: string, type: string): Promise<void> {
        if (this.connection) {
            try {
                logger.trace(`Setting remote descriptor for peer: ${this.remotePeerDescriptor.peerId.toString()}`)
                this.connection!.setRemoteDescription(description, type as DescriptionType)
                this.remoteDescriptionSet = true
            } catch (err) {
                console.error(err)
            }
        } else {
            this.close()
        }
    }

    addRemoteCandidate(candidate: string, mid: string): void {
        if (this.connection) {
            if (this.remoteDescriptionSet) {
                try {
                    logger.trace(`Setting remote candidate for peer: ${this.remotePeerDescriptor.peerId.toString()}`)
                    this.connection!.addRemoteCandidate(candidate, mid)
                } catch (err) {
                    console.error(err)
                }
            } else {
                this.close()
            }
        } else {
            this.close()
        }
    }

    setPeerDescriptor(peerDescriptor: PeerDescriptor): void {
        this.remotePeerDescriptor = peerDescriptor
    }

    getPeerDescriptor(): PeerDescriptor | undefined {
        return this.remotePeerDescriptor
    }

    send(data: Uint8Array): void {
        if (this.isOpen()) {
            this.doSend(data)
        } else {
            this.addToBuffer(data)
        }
    }

    sendBufferedMessages(): void {
        while (this.buffer.length > 0) {
            this.send(this.buffer.shift()!)
        }
    }

    private doSend(data: Uint8Array): void {
        this.dataChannel?.sendMessageBinary(data as Buffer)
    }

    private addToBuffer(msg: Uint8Array): void {
        this.buffer.push(msg)
    }

    getBufferedMessages(): Uint8Array[] {
        return this.buffer
    }

    close(): void {
        logger.trace(`Closing Node WebRTC Connection`)
        if (this.connectingTimeoutRef) {
            clearTimeout(this.connectingTimeoutRef)
        }
        this.emit(ConnectionEvent.DISCONNECTED)
        if (this.dataChannel) {
            this.dataChannel.close()
        }
        if (this.connection) {
            this.connection.close()
        }
        this.removeAllListeners()
    }

    private onDataChannel(dataChannel: DataChannel): void {
        this.openDataChannel(dataChannel)
        this.setupDataChannel(dataChannel)
    }

    private setupDataChannel(dataChannel: DataChannel): void {
        dataChannel.setBufferedAmountLowThreshold(this.bufferThresholdLow)
        dataChannel.onOpen(() => {
            logger.trace(`dc.onOpened`)
            this.openDataChannel(dataChannel)
        })

        dataChannel.onClosed(() => {
            logger.trace(`dc.closed`)
            this.close()
        })

        dataChannel.onError((err) => logger.error(err))

        dataChannel.onBufferedAmountLow( () => {
            logger.trace(`dc.onBufferedAmountLow`)
        })

        dataChannel.onMessage((msg) => {
            logger.trace(`dc.onMessage`)
            this.emit(ConnectionEvent.DATA, msg as Buffer)
        })
    }

    private openDataChannel(dataChannel: DataChannel): void {
        if (this.connectingTimeoutRef) {
            clearTimeout(this.connectingTimeoutRef)
        }
        this.dataChannel = dataChannel
        this.sendBufferedMessages()
        logger.trace(`DataChannel opened for peer ${this.remotePeerDescriptor.peerId.toString()}`)
        this.emit(ConnectionEvent.CONNECTED)

    }

    private onStateChange(state: string): void {
        if (!Object.keys(RTCPeerConnectionStateEnum).filter((s) => isNaN(+s)).includes(state)) {
            throw new IllegalRTCPeerConnectionState('NodeWebRtcConnection used an unknown state: ' + state)
        } else {
            this.lastState = state as RTCPeerConnectionState
        }
    }

    isOpen(): boolean {
        return this.lastState === 'connected' && !!this.dataChannel
    }

    public setConnectionId(connectionID: string): void {
        this.connectionId = new ConnectionID(connectionID)
    }
}
