import EventEmitter from "events"
import { Event, IWebRtcConnection, RtcDescription } from "./IWebRtcConnection"
import { IConnection, ConnectionID, Event as ConnectionEvent, ConnectionType } from "../IConnection"
import { PeerDescriptor } from "../../proto/DhtRpc"
import { IWebRtcCleanUp } from './IWebRtcCleanUp'
import { Logger } from '@streamr/utils'

const logger = new Logger(module)

export const WEB_RTC_CLEANUP = new class implements IWebRtcCleanUp {
    cleanUp(): void {
    }
}

export class NodeWebRtcConnection extends EventEmitter implements IWebRtcConnection, IConnection {

    public connectionId: ConnectionID = new ConnectionID()
    public readonly connectionType: ConnectionType = ConnectionType.WEBRTC

    // We need to keep track of connection state ourselves because
    // RTCPeerConnection.connectionState is not supported on Firefox
    
    private lastState: RTCPeerConnectionState = 'connecting'

    private stunUrls = ['stun:stun.l.google.com:19302']
    private peerConnection?: RTCPeerConnection
    private dataChannel?: RTCDataChannel
    private makingOffer = false
    private isOffering = false
    private buffer: Uint8Array[] = []

    private remotePeerDescriptor?: PeerDescriptor

    start(isOffering: boolean): void {
        this.isOffering = isOffering
        const urls: RTCIceServer[] = this.stunUrls.map((url) => { return { urls: [url] } })
        this.peerConnection = new RTCPeerConnection({ iceServers: urls })

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && event.candidate.sdpMid) {
                this.emit(Event.LOCAL_CANDIDATE, event.candidate.candidate, event.candidate.sdpMid)
            }
        }

        this.peerConnection.onicegatheringstatechange = () => {
            logger.trace('conn.onGatheringStateChange: %s -> %s', this.peerConnection?.iceGatheringState)
        }

        if (isOffering) {
            this.peerConnection.onnegotiationneeded = async () => {
                try {
                    if (this.peerConnection) {
                        this.makingOffer = true
                        try {
                            await this.peerConnection.setLocalDescription()
                        } catch (err) {
                            logger.warn(err)
                        }
                        if (this.peerConnection.localDescription) {
                            this.emit(Event.LOCAL_DESCRIPTION, this.peerConnection.localDescription?.sdp, this.peerConnection.localDescription?.type)
                        }
                    }
                } catch (err) {
                    logger.error(err)
                } finally {
                    this.makingOffer = false
                }
            }

            const dataChannel = this.peerConnection.createDataChannel('streamrDataChannel')
            this.setupDataChannel(dataChannel)
        } else {
            this.peerConnection.ondatachannel = (event) => {
                this.setupDataChannel(event.channel)
                logger.trace('connection.onDataChannel')
                this.openDataChannel(event.channel)
            }
        }
    }

    async setRemoteDescription(description: string, type: string): Promise<void> {
        const offerCollision = (type.toLowerCase() == RtcDescription.OFFER) && (this.makingOffer || !this.peerConnection ||
            this.peerConnection.signalingState != "stable")

        const ignoreOffer = this.isOffering && offerCollision
        if (ignoreOffer) {
            return
        }
        try {
            await this.peerConnection?.setRemoteDescription({ sdp: description, type: type.toLowerCase() as RTCSdpType })
        } catch (err) {
            logger.warn(err)
        }

        if (type.toLowerCase() == RtcDescription.OFFER && this.peerConnection) {
            try {
                await this.peerConnection.setLocalDescription()
            } catch (err) {
                logger.warn(err)
            }
            if (this.peerConnection.localDescription) {  
                this.emit(Event.LOCAL_DESCRIPTION, this.peerConnection.localDescription.sdp, this.peerConnection.localDescription.type)
            }
        }
    }

    addRemoteCandidate(candidate: string, mid: string): void {
        try {
            this.peerConnection?.addIceCandidate({ candidate: candidate, sdpMid: mid }).then(() => { return }).catch((err: any) => {
                logger.warn(err)
            })
        } catch (e) {
            logger.warn(e)
        }
    }

    isOpen(): boolean {
        return this.lastState === 'connected'
    }

    // IConnection implementation
    close(): void {
        this.lastState = 'closed'

        if (this.dataChannel) {
            try {
                this.dataChannel.close()
            } catch (e) {
                logger.warn('dc.close() errored: %s', e)
            }
        }

        this.dataChannel = undefined

        if (this.peerConnection) {
            try {
                this.peerConnection.close()
            } catch (e) {
                logger.warn('conn.close() errored: %s', e)
            }
        }

        this.peerConnection = undefined
    }

    setPeerDescriptor(peerDescriptor: PeerDescriptor): void {
        this.remotePeerDescriptor = peerDescriptor
    }

    getPeerDescriptor(): PeerDescriptor | undefined {
        return this.remotePeerDescriptor
    }

    send(data: Uint8Array): void {
        if (this.lastState == 'connected') {
            this.doSend(data)
        } else if (this.lastState == 'connecting') {
            this.addToBuffer(data)
        }
    }

    sendBufferedMessages(): void {
        while (this.buffer.length > 0) {
            this.send(this.buffer.shift() as Uint8Array)
        }
    }

    private doSend(data: Uint8Array): void {
        this.dataChannel?.send(data as Buffer)
    }

    private addToBuffer(msg: Uint8Array): void {
        this.buffer.push(msg)
    }

    getBufferedMessages(): Uint8Array[] {
        return this.buffer
    }

    private setupDataChannel(dataChannel: RTCDataChannel): void {
        dataChannel.onopen = () => {
            logger.trace('dc.onOpen')
            this.openDataChannel(dataChannel)
        }

        dataChannel.onclose = () => {
            logger.trace('dc.onClosed')
            this.close()
        }

        dataChannel.onerror = (err) => {
            logger.warn('dc.onError: %o', err)
        }

        dataChannel.onbufferedamountlow = () => {
            //this.emitLowBackpressure()
        }

        dataChannel.onmessage = (msg) => {
            logger.trace('dc.onmessage')
            this.emit(ConnectionEvent.DATA, new Uint8Array(msg.data))
        }
    }

    private openDataChannel(dataChannel: RTCDataChannel): void {
        this.dataChannel = dataChannel
        this.lastState = 'connected'
        this.emit(ConnectionEvent.CONNECTED)
    }

    public setConnectionId(connectionID: string): void {
        this.connectionId = new ConnectionID(connectionID)
    }
}
