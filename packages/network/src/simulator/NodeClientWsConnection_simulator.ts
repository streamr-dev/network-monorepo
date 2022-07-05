import { ReadyState, AbstractWsConnection } from '../connection/ws/AbstractWsConnection'
import  NodeClientWsEndpoint from './NodeClientWsEndpoint_simulator'
import { PeerInfo } from '../connection/PeerInfo'
import { DisconnectionCode, DisconnectionReason } from '../connection/ws/AbstractWsEndpoint'
//import { Logger } from '../helpers/Logger'
//import { WebSocketConnectionFactory } from "./AbstractClientWsEndpoint_simulator"
import { Simulator } from './Simulator'

//const staticLogger = new Logger(module)

/*
export const NodeWebSocketConnectionFactory: WebSocketConnectionFactory<NodeClientWsConnection> = Object.freeze({
    createConnection(peerInfo: PeerInfo): NodeClientWsConnection {
        return new NodeClientWsConnection(peerInfo)
    }
})
*/

export class NodeClientWsConnection extends AbstractWsConnection {
    
    private readyState: ReadyState = 1
    
    constructor(private ownAddress: string, 
        private ownPeerInfo: PeerInfo, 
        private remoteAddress: string, 
        private remotePeerInfo: PeerInfo,
        private endpoint: NodeClientWsEndpoint) {
        super(remotePeerInfo)
    }

    close(code: DisconnectionCode, reason: DisconnectionReason): void {
        Simulator.instance().wsDisconnect(this.ownAddress, this.ownPeerInfo, this.remoteAddress, code, reason)
        this.readyState = 3
        this.endpoint.doOnClose(this, code, reason)
    }

    terminate(): void {
        Simulator.instance().wsDisconnect(this.ownAddress,this.ownPeerInfo, this.remoteAddress, 
            DisconnectionCode.GRACEFUL_SHUTDOWN, DisconnectionReason.GRACEFUL_SHUTDOWN)
        this.readyState = 3
        this.endpoint.doOnClose(this, DisconnectionCode.DEAD_CONNECTION, '')
    }

    getBufferedAmount(): number {
        return 0
    }

    getReadyState(): ReadyState {
        return this.readyState
    }

    sendPing(): void {
        Simulator.instance().wsSend(this.ownAddress, this.ownPeerInfo, this.remoteAddress, "ping").then(() => { return }).catch((_ue) => {})
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
   
}
