import {
    PeerDescriptor,
    WebSocketConnectionRequest,
    WebSocketConnectionResponse
} from '../../proto/DhtRpc'
import { IWebSocketConnectorClient } from '../../proto/DhtRpc.client'
import { PeerID } from '../../PeerID'
import { DhtRpcOptions } from '../../rpc-protocol/ClientTransport'
import { DummyServerCallContext } from '../../rpc-protocol/ServerTransport'
import { ServerCallContext } from '@protobuf-ts/runtime-rpc'
import { TODO } from '../../types'
import { IWebSocketConnector } from '../../proto/DhtRpc.server'

export class RemoteWebSocketConnector {
    private peerId: PeerID
    constructor(private peerDescriptor: PeerDescriptor, private client: IWebSocketConnectorClient) {
        this.peerId = PeerID.fromValue(peerDescriptor.peerId)
    }

    async requestConnection(sourceDescriptor: PeerDescriptor, ip: string, port: number): Promise<boolean> {
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
            const response = await this.client.requestConnection(request, options)
            const res = await response.response
            if (res.reason) {
                // Log warning?
            }
            return res.accepted
        } catch (err) {
            console.error(err)
            return false
        }
    }
}

export const createRemoteWebSocketConnectorServer = (connectFn: TODO, canConnect: TODO): any => {
    const rpc: IWebSocketConnector = {
        async requestConnection(request: WebSocketConnectionRequest, _context: ServerCallContext): Promise<WebSocketConnectionResponse>  {
            if (canConnect(request.requester, request.ip, request.port)) {
                setImmediate(() => connectFn({host: request.ip, port: request.port}))
                const res: WebSocketConnectionResponse = {
                    accepted: true
                }
                return res
            }
            const res: WebSocketConnectionResponse = {
                accepted: false
            }
            return res
        }
    }
    const registerRpc = {
        async requestConnection(bytes: Uint8Array): Promise<Uint8Array> {
            const request = WebSocketConnectionRequest.fromBinary(bytes)
            const response = await rpc.requestConnection(request, new DummyServerCallContext())
            return WebSocketConnectionResponse.toBinary(response)
        },
    }
    return registerRpc
}