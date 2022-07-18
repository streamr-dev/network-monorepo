import {
    ClientStreamingCall,
    ServerStreamingCall,
    DuplexStreamingCall,
    Deferred,
    RpcTransport,
    MethodInfo,
    RpcError,
    RpcOptions,
    RpcMetadata,
    RpcStatus,
    UnaryCall,
    mergeRpcOptions
} from '@protobuf-ts/runtime-rpc'
import { v4 } from 'uuid'
import { RpcMessage } from './proto/ProtoRpc'
import EventEmitter from 'events'
import { Logger } from '@streamr/utils'

export enum Event {
    RPC_REQUEST = 'rpcRequest'
}

export interface ClientTransport {
    on(event: Event.RPC_REQUEST, listener: (results: ResultParts, rpcMessage: RpcMessage, options: ProtoRpcOptions) => void): this
}

export interface ResultParts {
    header: Deferred<RpcMetadata>
    message: Deferred<object>
    status: Deferred<RpcStatus>
    trailer: Deferred<RpcMetadata>
    messageParser: (bytes: Uint8Array) => object
}

export interface ProtoRpcOptions extends RpcOptions {
    notification?: boolean
}

const logger = new Logger(module)

export class ClientTransport extends EventEmitter implements RpcTransport {
    private static objectCount = 0
    private readonly objectId: number
    protected readonly defaultOptions: ProtoRpcOptions

    constructor(defaultTimeout = 5000) {
        super()
        this.objectId = ClientTransport.objectCount++
        this.defaultOptions = {
            timeout: defaultTimeout,
            clientId: this.objectId
        }
    }

    mergeOptions(options?: Partial<ProtoRpcOptions>): ProtoRpcOptions {
        return mergeRpcOptions(this.defaultOptions, options)
    }

    private static createRequestHeaders(method: MethodInfo, notification?: boolean): {
        method: string
        request: string
        notification?: string
    } {
        return {
            method: method.localName,
            request: 'request',
            notification: notification ? 'notification' : undefined
        }
    }

    unary<I extends object, O extends object>(method: MethodInfo<I, O>, input: I, options: ProtoRpcOptions): UnaryCall<I, O> {
        const requestBody = method.I.toBinary(input)
        const defHeader = new Deferred<RpcMetadata>()
        const defMessage = new Deferred<O>()
        const defStatus = new Deferred<RpcStatus>()
        const defTrailer = new Deferred<RpcMetadata>()

        const request: RpcMessage = {
            header: ClientTransport.createRequestHeaders(method, options.notification),
            body: requestBody,
            requestId: v4()
        }

        const unary = new UnaryCall<I, O>(
            method,
            {},
            input,
            defHeader.promise,
            defMessage.promise,
            defStatus.promise,
            defTrailer.promise,
        )

        const deferredParser = (bytes: Uint8Array) => method.O.fromBinary(bytes)
        const deferred: ResultParts = {
            message: defMessage,
            header: defHeader,
            trailer: defTrailer,
            status: defStatus,
            messageParser: deferredParser
        }
        logger.trace(`New rpc ${options.notification ? 'notification' : 'request'}, ${request.requestId}`)
        this.emit(Event.RPC_REQUEST, deferred, request, options)
        return unary
    }

    clientStreaming<I extends object, O extends object>(method: MethodInfo<I, O>): ClientStreamingCall<I, O> {
        const e = new RpcError('Client streaming is not supported by DhtTransport')
        e.methodName = method.name
        e.serviceName  = method.service.typeName
        throw e
    }

    duplex<I extends object, O extends object>(method: MethodInfo<I, O>): DuplexStreamingCall<I, O> {
        const e = new RpcError('Duplex streaming is not supported by DhtTransport')
        e.methodName = method.name
        e.serviceName  = method.service.typeName
        throw e
    }

    serverStreaming<I extends object, O extends object>(method: MethodInfo<I, O>): ServerStreamingCall<I, O> {
        const e = new RpcError('Server streaming is not supported by DhtTransport')
        e.methodName = method.name
        e.serviceName  = method.service.typeName
        throw e
    }

    stop(): void {
        this.removeAllListeners()
    }
}
