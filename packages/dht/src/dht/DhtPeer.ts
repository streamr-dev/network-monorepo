import { IDhtRpcClient } from '../proto/DhtRpc.client'
import { ClosestPeersRequest, PeerDescriptor, PingRequest, RouteMessageWrapper } from '../proto/DhtRpc'
import { v4 } from 'uuid'
import { PeerID } from '../helpers/PeerID'
import { jsFormatPeerDescriptor } from '../helpers/common'
import { DhtRpcOptions } from '../rpc-protocol/DhtRpcOptions'
import { RouteMessageParams } from './DhtNode'
import { Logger } from '@streamr/utils'

const logger = new Logger(module)

// Fields required by objects stored in the k-bucket library
interface KBucketContact {
    id: Uint8Array
    vectorClock: number
}

export class DhtPeer implements KBucketContact {
    private static counter = 0
    
    public readonly peerId: PeerID

    public get id(): Uint8Array {
        return this.peerId.value
    }

    private peerDescriptor: PeerDescriptor
    public vectorClock: number
    private readonly dhtClient: IDhtRpcClient
    
    constructor(peerDescriptor: PeerDescriptor, client: IDhtRpcClient) {
        this.peerId = PeerID.fromValue(peerDescriptor.peerId)
        this.peerDescriptor = peerDescriptor
        this.vectorClock = DhtPeer.counter++
        this.dhtClient = client
        this.getClosestPeers = this.getClosestPeers.bind(this)
        this.ping = this.ping.bind(this)
    }

    async getClosestPeers(sourceDescriptor: PeerDescriptor): Promise<PeerDescriptor[]> {
        const request: ClosestPeersRequest = {
            peerDescriptor: sourceDescriptor,
            nonce: v4()
        }
        const options: DhtRpcOptions = {
            sourceDescriptor: sourceDescriptor as PeerDescriptor,
            targetDescriptor: this.peerDescriptor as PeerDescriptor
        }

        try {
            const results = this.dhtClient.getClosestPeers(request, options)
            const peers = await results.response
            return peers.peers.map((peer) => jsFormatPeerDescriptor(peer))
        } catch (err) {
            logger.debug(err)
            return []
        }

    }

    async ping(sourceDescriptor: PeerDescriptor): Promise<boolean> {
        const request: PingRequest = {
            nonce: v4()
        }
        const options: DhtRpcOptions = {
            sourceDescriptor: sourceDescriptor as PeerDescriptor,
            targetDescriptor: this.peerDescriptor as PeerDescriptor
        }
        try {
            const results = this.dhtClient.ping(request, options)
            const pong = await results.response
            if (pong.nonce === request.nonce) {
                return true
            }
        } catch (err) {
            logger.debug(err)
        }
        return false
    }

    async routeMessage(params: RouteMessageParams): Promise<boolean> {
        const message: RouteMessageWrapper = {
            destinationPeer: params.destinationPeer,
            sourcePeer: params.sourcePeer,
            previousPeer: params.previousPeer,
            message: params.message,
            nonce: params.messageId || v4()
        }
        const options: DhtRpcOptions = {
            sourceDescriptor: params.previousPeer as PeerDescriptor,
            targetDescriptor: this.peerDescriptor as PeerDescriptor
        }
        try {
            const results = this.dhtClient.routeMessage(message, options)
            const ack = await results.response
            if (ack.error!.length > 0) {
                return false
            }
        } catch (err) {
            logger.debug(err)
            return false
        }
        return true
    }

    getPeerDescriptor(): PeerDescriptor {
        return this.peerDescriptor
    }
}
