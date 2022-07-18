import { Message, PeerDescriptor } from '../proto/DhtRpc'

export enum Event {
    DATA = 'streamr:dht-node:layer-0:message-router:on-data'
}

export interface ITransport {
    on(event: Event.DATA, listener: (message: Message, peerDescriptor: PeerDescriptor) => void): this
    send(msg: Message, peerDescriptor: PeerDescriptor): void
    getPeerDescriptor(): PeerDescriptor
}
