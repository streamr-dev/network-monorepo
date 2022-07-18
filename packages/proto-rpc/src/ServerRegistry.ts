import { RpcMessage } from './proto/ProtoRpc'
import EventEmitter from 'events'
import { RpcMetadata, ServerCallContext } from '@protobuf-ts/runtime-rpc'
import { BinaryReadOptions, BinaryWriteOptions } from '@protobuf-ts/runtime'
import { promiseTimeout } from './common'
import * as Err from './errors'
import UnknownRpcMethod = Err.UnknownRpcMethod
import { ProtoRpcOptions } from './ClientTransport'
import { Empty } from './proto/google/protobuf/empty'
import { Logger } from '@streamr/utils'

export enum ServerRegistryEvent {
    RPC_RESPONSE = 'rpcResponse',
    RPC_REQUEST = 'rpcRequest',
}

export interface ServerRegistry {
    on(event: ServerRegistryEvent.RPC_RESPONSE, listener: (rpcMessage: RpcMessage) => void): this
    on(event: ServerRegistryEvent.RPC_REQUEST, listener: (rpcMessage: RpcMessage) => void): this
}

export interface Parser<Target> { fromBinary: (data: Uint8Array, options?: Partial<BinaryReadOptions>) => Target }
export interface Serializer<Target> { toBinary: (message: Target, options?: Partial<BinaryWriteOptions>) => Uint8Array }

type RegisteredMethod = (request: Uint8Array, callContext: CallContext) => Promise<Uint8Array>
type RegisteredNotification = (request: Uint8Array, callContext: CallContext) => Promise<Empty>

const logger = new Logger(module)

export function parseWrapper<T>(parseFn: () => T): T | never {
    try {
        return parseFn()
    } catch (err) {
        throw new Err.FailedToParse(`Could not parse binary to JSON-object`, err)
    }
}

export function serializeWrapper(serializerFn: () => Uint8Array): Uint8Array | never {
    try {
        return serializerFn()
    } catch (err) {
        throw new Err.FailedToSerialize(`Could not serialize message to binary`, err)
    }
}

export class ServerRegistry extends EventEmitter {
    private methods = new Map<string, RegisteredMethod | RegisteredNotification>()
    private stopped = false

    public async onRequest(rpcMessage: RpcMessage, callContext?: CallContext): Promise<Uint8Array> {
        if (this.stopped) {
            return new Uint8Array()
        }
        logger.trace(`Server processing request ${rpcMessage.requestId}`)
        const methodName = rpcMessage.header.method
        if (methodName === undefined) {
            throw new UnknownRpcMethod('Header "method" missing from RPC message')
        }
        const fn = this.methods.get(methodName) as RegisteredMethod
        if (!fn) {
            throw new UnknownRpcMethod(`RPC Method ${methodName} is not provided`)
        }

        return await promiseTimeout(1000, fn!(rpcMessage.body, callContext ? callContext : new CallContext()))
    }

    public async onNotification(rpcMessage: RpcMessage, callContext?: CallContext): Promise<Empty> {
        if (this.stopped) {
            return {} as Empty
        }
        logger.trace(`Server processing notification ${rpcMessage.requestId}`)
        const methodName = rpcMessage.header.method
        if (methodName === undefined) {
            throw new UnknownRpcMethod('Header "method" missing from RPC message')
        }
        const fn = this.methods.get(methodName) as RegisteredNotification
        if (!fn) {
            throw new UnknownRpcMethod(`RPC Method ${methodName} is not provided`)
        }
        return await promiseTimeout(1000, fn!(rpcMessage.body, callContext ? callContext : new CallContext()))
    }

    public registerRpcMethod<RequestClass extends Parser<RequestType>, ReturnClass extends Serializer<ReturnType>, RequestType, ReturnType>(
        requestClass: RequestClass,
        returnClass: ReturnClass,
        name: string,
        fn: (rq: RequestType, _context: CallContext) => Promise<ReturnType>
    ): void {
        this.methods.set(name, async (bytes: Uint8Array, callContext: CallContext) => {
            const request = parseWrapper(() => requestClass.fromBinary(bytes))
            const response = await fn(request, callContext)
            return returnClass.toBinary(response)
        })
    }

    public registerRpcNotification<RequestClass extends Parser<RequestType>, RequestType>(
        requestClass: RequestClass,
        name: string,
        fn: (rq: RequestType, _context: CallContext) => Promise<Empty>
    ): void {
        this.methods.set(name, async (bytes: Uint8Array, callContext: CallContext): Promise<Empty> => {
            const request = parseWrapper(() => requestClass.fromBinary(bytes))
            const response = await fn(request, callContext)
            return Empty.toBinary(response)
        })
    }

    public stop(): void {
        this.stopped = true
        this.methods.clear()
    }
}

export class CallContext implements ServerCallContext, ProtoRpcOptions {
    method = undefined as unknown as any
    headers = undefined as unknown as any
    deadline = undefined as unknown as any
    trailers = undefined as unknown as any
    status = undefined as unknown as any
    sendResponseHeaders(_data: RpcMetadata): void {
        throw new Err.NotImplemented('Method not implemented.')
    }
    cancelled = undefined as unknown as any
    onCancel(_cb: () => void): () => void {
        throw new Err.NotImplemented('Method not implemented.')
    }

    // own extensions
    [extra: string]: unknown
    notification?: boolean
}
