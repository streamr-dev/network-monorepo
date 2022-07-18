import {
    PeerDescriptor,
    WebSocketConnectionRequest
} from '../../proto/DhtRpc'
import { IWebSocketConnectorClient } from '../../proto/DhtRpc.client'
import { PeerID } from '../../helpers/PeerID'
import { DhtRpcOptions } from '../../rpc-protocol/DhtRpcOptions'
import { Logger } from '@streamr/utils'
import * as Err from '../../helpers/errors'

const logger = new Logger(module)

export class RemoteWebSocketConnector {
    private peerId: PeerID
    constructor(private peerDescriptor: PeerDescriptor, private client: IWebSocketConnectorClient) {
        this.peerId = PeerID.fromValue(peerDescriptor.peerId)
    }

    async requestConnection(sourceDescriptor: PeerDescriptor, ip: string, port: number): Promise<boolean> {
        logger.trace(`Requesting WebSocket connection from ${this.peerDescriptor.peerId.toString()}`)
        const request: WebSocketConnectionRequest = {
            target: this.peerDescriptor,
            requester: sourceDescriptor,
            ip,
            port
        }
        const options: DhtRpcOptions = {
            sourceDescriptor: sourceDescriptor as PeerDescriptor,
            targetDescriptor: this.peerDescriptor as PeerDescriptor
        }
        try {
            const results = this.client.requestConnection(request, options)
            const res = await results.response
            if (res.reason) {
                // TODO: Log warning?
                logger.debug('WebSocketConnectionRequest Rejected', new Err.WebSocketConnectionRequestRejected(res.reason).stack)
            }
            return res.accepted
        } catch (err) {
            logger.debug(new Err.WebSocketConnectionRequestRejected('WebSocketConnectionRequest rejected', err).stack!)
            return false
        }
    }
}
