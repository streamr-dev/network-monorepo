import { INetworkRpcClient } from '../proto/NetworkRpc.client'
import { PeerDescriptor, UUID, PeerID } from '@streamr/dht'
import { DataMessage, HandshakeRequest, LeaveNotice } from '../proto/NetworkRpc'
import { DhtRpcOptions } from '@streamr/dht/dist/src/rpc-protocol/DhtRpcOptions'
export class RemoteRandomGraphNode {
    private remotePeerDescriptor: PeerDescriptor
    private client: INetworkRpcClient
    private graphId: string
    constructor(peerDescriptor: PeerDescriptor, graphId: string, client: INetworkRpcClient) {
        this.remotePeerDescriptor = peerDescriptor
        this.client = client
        this.graphId = graphId
    }

    async handshake(ownPeerDescriptor: PeerDescriptor): Promise<boolean> {
        const request: HandshakeRequest = {
            randomGraphId: this.graphId,
            requestId: new UUID().toString(),
            senderId: PeerID.fromValue(ownPeerDescriptor.peerId).toMapKey()
        }
        const options: DhtRpcOptions = {
            sourceDescriptor: ownPeerDescriptor as PeerDescriptor,
            targetDescriptor: this.remotePeerDescriptor as PeerDescriptor
        }
        try {
            const result = await this.client.handshake(request, options)
            const response = await result.response
            return response.accepted
        } catch (err) {
            console.error(err)
            return false
        }
    }

    async sendData(ownPeerDescriptor: PeerDescriptor, dataMessage: DataMessage): Promise<void> {
        const options: DhtRpcOptions = {
            sourceDescriptor: ownPeerDescriptor as PeerDescriptor,
            targetDescriptor: this.remotePeerDescriptor as PeerDescriptor,
            notification: true
        }
        try {
            await this.client.sendData(dataMessage, options)
        } catch (err) {
            console.error(err)
        }
    }

    leaveNotice(ownPeerDescriptor: PeerDescriptor): void {
        const options: DhtRpcOptions = {
            sourceDescriptor: ownPeerDescriptor as PeerDescriptor,
            targetDescriptor: this.remotePeerDescriptor as PeerDescriptor,
            notification: true
        }
        const notification: LeaveNotice = {
            senderId: PeerID.fromValue(ownPeerDescriptor.peerId).toMapKey(),
            randomGraphId: this.graphId
        }
        this.client.leaveNotice(notification, options)
    }

    getPeerDescriptor(): PeerDescriptor {
        return this.remotePeerDescriptor
    }
}