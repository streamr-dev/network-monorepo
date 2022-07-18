import { IConnection } from './IConnection'
import { PeerDescriptor } from '../proto/DhtRpc'

export enum Event {
    CONNECTED = 'streamr:dht:connectionsource:connected'
}

export interface IConnectionSource {
    on(event: Event.CONNECTED, listener: (connection: IConnection) => void): this
    once(event: Event.CONNECTED, listener: (connection: IConnection) => void): this
    setOwnPeerDescriptor(peerDescriptor: PeerDescriptor): void
}
