import { ReadyState, AbstractWsConnection } from '../connection/ws/AbstractWsConnection'
import { PeerInfo } from '../connection/PeerInfo'
import { DisconnectionCode, DisconnectionReason } from '../connection/ws/AbstractWsEndpoint'
import { Logger } from "@streamr/utils"

import { Simulator } from './Simulator'

export const staticLogger = new Logger(module)

export class ServerWsConnection extends AbstractWsConnection {

    private readyState: ReadyState = 1
    constructor(private ownAddress: string,
        private ownPeerInfo: PeerInfo,
        private remoteAddress: string,
        private remotePeerInfo: PeerInfo) {
        super(remotePeerInfo)
    }

    close(code: DisconnectionCode, reason: DisconnectionReason): void {
        Simulator.instance().wsDisconnect(this.ownAddress, this.ownPeerInfo, this.remoteAddress, code, reason)
        this.readyState = 3
    }

    terminate(): void {
        Simulator.instance().wsDisconnect(this.ownAddress, this.ownPeerInfo, this.remoteAddress, DisconnectionCode.GRACEFUL_SHUTDOWN, 
            DisconnectionReason.GRACEFUL_SHUTDOWN)
        this.readyState = 3
    }

    getBufferedAmount(): number {
        return 0
    }

    getReadyState(): ReadyState {
        return this.readyState
    }

    sendPing(): void {
        Simulator.instance().wsSend(this.ownAddress, this.ownPeerInfo, this.remoteAddress, "ping").then(() => {
            return
        }).catch(() => {
        })
    }

    async send(message: string): Promise<void> {
        const readyState = this.getReadyState()
        if (this.getReadyState() !== 1) {
            throw new Error(`cannot send, readyState is ${readyState}`)
        }
        try {
            await Simulator.instance().wsSend(this.ownAddress, this.ownPeerInfo, this.remoteAddress, message)
        } catch (err) {
            return Promise.reject(err)
        }
    }

    getRemoteAddress(): string | undefined {
        return this.remoteAddress
    }
}
