import EventEmitter = require('events');
import { DeferredPromises, DhtTransportClient, Event as DhtTransportClientEvent } from './DhtTransportClient'
import { PeerDescriptor, RpcWrapper } from '../proto/DhtRpc'
import { DhtTransportServer } from './DhtTransportServer'
import { IConnectionManager, Event as ConnectionLayerEvent } from '../connection/IConnectionManager'
import { nodeFormatPeerDescriptor } from '../dht/helpers'

export enum Event {
    OUTGOING_MESSAGE = 'streamr:dht:transport:rpc-communicator:outgoing-message',
    INCOMING_MESSAGE = 'streamr:dht:transport:rpc-communicator:incoming-message'
}

export interface RpcCommunicator {
    on(event: Event.OUTGOING_MESSAGE, listener: () => void): this
    on(event: Event.INCOMING_MESSAGE, listener: () => void): this
}

export class RpcCommunicator extends EventEmitter {
    private readonly dhtTransportClient: DhtTransportClient
    private readonly dhtTransportServer: DhtTransportServer
    private readonly connectionLayer: IConnectionManager
    private readonly ongoingRequests: Map<string, DeferredPromises>
    public send: (peerDescriptor: PeerDescriptor, bytes: Uint8Array) => void
    constructor(connectionLayer: IConnectionManager, dhtTransportClient: DhtTransportClient, dhtTransportServer: DhtTransportServer) {
        super()
        this.dhtTransportClient = dhtTransportClient
        this.dhtTransportServer = dhtTransportServer
        this.connectionLayer = connectionLayer
        this.ongoingRequests = new Map()
        this.send = ((_peerDescriptor, _bytes) => { throw new Error('send not defined') })
        this.dhtTransportClient.on(DhtTransportClientEvent.RPC_REQUEST, (deferredPromises: DeferredPromises, rpcWrapper: RpcWrapper) => {
            this.onOutgoingMessage(rpcWrapper, deferredPromises)
        })
        this.connectionLayer.on(ConnectionLayerEvent.DATA, async (peerDescriptor: PeerDescriptor, bytes: Uint8Array) =>
            await this.onIncomingMessage(peerDescriptor, bytes)
        )
    }

    onOutgoingMessage(rpcWrapper: RpcWrapper, deferredPromises?: DeferredPromises): void {
        if (deferredPromises) {
            this.registerRequest(rpcWrapper.requestId, deferredPromises)
        }
        const data = RpcWrapper.toBinary(rpcWrapper)
        this.send(rpcWrapper.targetDescriptor!, data)
    }

    async onIncomingMessage(senderDescriptor: PeerDescriptor, data: Uint8Array): Promise<void> {
        const rpcCall = RpcWrapper.fromBinary(data)
        if (rpcCall.header.response && this.ongoingRequests.has(rpcCall.requestId)) {
            this.resolveOngoingRequest(rpcCall)
        } else if (rpcCall.header.request && rpcCall.header.method) {
            await this.handleRequest(senderDescriptor, rpcCall)
        }
    }

    async handleRequest(senderDescriptor: PeerDescriptor, rpcWrapper: RpcWrapper): Promise<void> {
        const bytes = await this.dhtTransportServer.onRequest(senderDescriptor, rpcWrapper)
        const responseWrapper: RpcWrapper = {
            body: bytes,
            header: {
                response: "response",
                method: rpcWrapper.header.method
            },
            requestId: rpcWrapper.requestId,
            targetDescriptor: nodeFormatPeerDescriptor(senderDescriptor as PeerDescriptor)
        }
        this.onOutgoingMessage(responseWrapper)
    }

    registerRequest(requestId: string, deferredPromises: DeferredPromises): void {
        // TODO: add timeouts?
        this.ongoingRequests.set(requestId, deferredPromises)
    }

    setSendFn(fn: (peerDescriptor: PeerDescriptor, bytes: Uint8Array) => void): void {
        this.send = fn
    }

    resolveOngoingRequest(response: RpcWrapper): void {
        const deferredPromises = this.ongoingRequests.get(response.requestId)
        const parsedResponse = deferredPromises!.messageParser(response.body)
        deferredPromises!.message.resolve(parsedResponse)
        deferredPromises!.header.resolve({})
        deferredPromises!.status.resolve({code: 'OK', detail: ''})
        deferredPromises!.trailer.resolve({})
        this.ongoingRequests.delete(response.requestId)
    }

    stop(): void {
        this.removeAllListeners()
        this.send = () => {}
    }
}