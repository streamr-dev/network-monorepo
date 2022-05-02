import { PeerDescriptor, RpcMessage } from '../proto/DhtRpc'
import EventEmitter = require('events')
import { MethodInfo, RpcMetadata, RpcStatus, ServerCallContext } from '@protobuf-ts/runtime-rpc'

export enum Event {
    RPC_RESPONSE = 'streamr:dht-transport:server:response-new',
    RPC_REQUEST = 'streamr:dht-transport:server:request-new',
}

export interface DhtTransportServer {
    on(event: Event.RPC_RESPONSE, listener: (rpcMessage: RpcMessage) => void): this
    on(event: Event.RPC_REQUEST, listener: (rpcMessage: RpcMessage) => void): this
}

export type RegisteredMethod = (request: Uint8Array) => Promise<Uint8Array>

export class DhtTransportServer extends EventEmitter {
    methods: Map<string, RegisteredMethod>
    constructor() {
        super()
        this.methods = new Map()
    }

    async onRequest(peerDescriptor: PeerDescriptor, rpcMessage: RpcMessage): Promise<Uint8Array> {
        const fn = this.methods.get(rpcMessage.header.method)!
        return await fn(rpcMessage.body)
    }

    registerMethod(name: string, fn: RegisteredMethod): void {
        this.methods.set(name, fn)
    }

    removeMethod(name: string): void {
        this.methods.delete(name)
    }

    stop(): void {
        this.methods.clear()
    }
}

export class DummyServerCallContext implements ServerCallContext {
    method: MethodInfo<any, any> = {
        // @ts-expect-error TS2322
        I: undefined,
        // @ts-expect-error TS2322
        O: undefined,
        // @ts-expect-error TS2322
        service: undefined,
        name: '',
        localName: '',
        idempotency: undefined,
        serverStreaming: false,
        clientStreaming: false,
        options: {}
    }
    headers: Readonly<RpcMetadata> = {}
    deadline: Date = new Date()
    trailers: RpcMetadata = {}
    status: RpcStatus = {
        code: '',
        detail: ''
    }
    sendResponseHeaders(_data: RpcMetadata): void {
        throw new Error('Method not implemented.')
    }
    cancelled = false
    onCancel(_cb: () => void): () => void {
        throw new Error('Method not implemented.')
    }
    constructor() {}
}