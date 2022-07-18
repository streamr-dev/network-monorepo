import { Message, PeerDescriptor } from '../proto/DhtRpc'
import { EventEmitter } from 'events'
import { ITransport, Event } from '../transport/ITransport'
import { Simulator } from './Simulator'

export class SimulatorTransport extends EventEmitter implements ITransport {
    constructor(private ownPeerDescriptor: PeerDescriptor, private simulator: Simulator) {
        super()
        this.simulator.addConnectionManager(this)
    }

    send(msg: Message, peerDescriptor: PeerDescriptor): void {
        this.simulator.send(this.ownPeerDescriptor, peerDescriptor, msg)
    }

    disconnect(_peerDescriptor: PeerDescriptor): void { }

    getPeerDescriptor(): PeerDescriptor {
        return this.ownPeerDescriptor
    }

    handleIncomingMessage(peerDescriptor: PeerDescriptor, msg: Message): void {
        this.emit(Event.DATA, msg, peerDescriptor)
    }
}
