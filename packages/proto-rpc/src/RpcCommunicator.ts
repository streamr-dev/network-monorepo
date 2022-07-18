import * as Err from './errors'
import { ErrorCode } from './errors'
import {
    ClientTransport,
    ResultParts,
    ProtoRpcOptions,
    Event as DhtTransportClientEvent
} from './ClientTransport'
import {
    RpcMessage,
    RpcResponseError
} from './proto/ProtoRpc'
import { Empty } from './proto/google/protobuf/empty'
import { CallContext, ServerRegistryEvent as ServerRegistryEvent, Parser, Serializer, ServerRegistry } from './ServerRegistry'
import { EventEmitter } from 'events'
import { DeferredState } from '@protobuf-ts/runtime-rpc'
import { ServerCallContext } from '@protobuf-ts/runtime-rpc'
import { Logger } from '@streamr/utils'

export enum StatusCode {
    OK = 'OK',
    STOPPED = 'STOPPED',
    DEADLINE_EXCEEDED = 'DEADLINE_EXCEEDED',
    SERVER_ERROR = 'SERVER_ERROR'
}

export enum RpcCommunicatorEvent {
    OUTGOING_MESSAGE = 'outgoing-message',
}

export interface RpcCommunicatorConfig {
    rpcRequestTimeout?: number
}

interface IRpcIo {
    handleIncomingMessage(message: Uint8Array, callContext?: CallContext): Promise<void> 
    on(event: RpcCommunicatorEvent.OUTGOING_MESSAGE, listener: (message: Uint8Array, callContext?: CallContext) => void): this
}

interface OngoingRequest {
    deferredPromises: ResultParts
    timeoutRef: NodeJS.Timeout
}

const logger = new Logger(module)

export class RpcCommunicator extends EventEmitter implements IRpcIo {
    private stopped = false
    private readonly rpcClientTransport: ClientTransport
    private readonly rpcServerRegistry: ServerRegistry
    private readonly ongoingRequests: Map<string, OngoingRequest>
    private readonly rpcRequestTimeout: number

    constructor(params?: RpcCommunicatorConfig) {
        super()

        this.rpcRequestTimeout = params?.rpcRequestTimeout ?? 5000
        this.rpcClientTransport = new ClientTransport(this.rpcRequestTimeout)
        this.rpcServerRegistry = new ServerRegistry()
        this.ongoingRequests = new Map()
        
        this.rpcClientTransport.on(DhtTransportClientEvent.RPC_REQUEST, (
            deferredPromises: ResultParts,
            rpcMessage: RpcMessage,
            options: ProtoRpcOptions
        ) => {
            this.onOutgoingMessage(rpcMessage, deferredPromises, options as CallContext)
        })
        this.rpcServerRegistry.on(ServerRegistryEvent.RPC_RESPONSE, (rpcMessage: RpcMessage) => {
            this.onOutgoingMessage(rpcMessage)
        })
    }

    public async handleIncomingMessage(message: Uint8Array, callContext?: CallContext): Promise<void> {
        if (this.stopped) {
            return
        }
        const rpcCall = RpcMessage.fromBinary(message)
        return this.onIncomingMessage(rpcCall, callContext)
    }

    public onOutgoingMessage(rpcMessage: RpcMessage, deferredPromises?: ResultParts, callContext?: CallContext): void {
        if (this.stopped) {
            return
        }
        const requestOptions = this.rpcClientTransport.mergeOptions(callContext )
        if (deferredPromises && rpcMessage.header.notification) {
            this.resolveDeferredPromises(deferredPromises, this.createNotificationResponse(rpcMessage.requestId))
        } else if (deferredPromises) {
            this.registerRequest(rpcMessage.requestId, deferredPromises, requestOptions!.timeout as number)
        }
        const msg = RpcMessage.toBinary(rpcMessage)

        logger.trace(`onOutGoingMessage, messageId: ${rpcMessage.requestId}`)
        
        this.emit(RpcCommunicatorEvent.OUTGOING_MESSAGE, msg, callContext)
    }

    private async onIncomingMessage(rpcMessage: RpcMessage, callContext?: CallContext): Promise<void> {
        logger.trace(`onIncomingMessage, requestId: ${rpcMessage.requestId}`)
        
        if (rpcMessage.header.response && this.ongoingRequests.has(rpcMessage.requestId)) {
            if (rpcMessage.responseError !== undefined) {
                this.rejectOngoingRequest(rpcMessage)
            } else {
                this.resolveOngoingRequest(rpcMessage)
            }
        } else if (rpcMessage.header.request && rpcMessage.header.method) {
            if (rpcMessage.header.notification) {
                await this.handleNotification(rpcMessage, callContext)
            } else {
                await this.handleRequest(rpcMessage, callContext)
            }
        }
    }

    public getRpcClientTransport(): ClientTransport {
        return this.rpcClientTransport
    }

    public registerRpcMethod<RequestClass extends Parser<RequestType>, ReturnClass extends Serializer<ReturnType>, RequestType, ReturnType>(
        requestClass: RequestClass,
        returnClass: ReturnClass,
        name: string,
        fn: (rq: RequestType, _context: ServerCallContext) => Promise<ReturnType>
    ): void {
        this.rpcServerRegistry.registerRpcMethod(requestClass, returnClass, name, fn)
    }

    public registerRpcNotification<RequestClass extends Parser<RequestType>, RequestType>(
        requestClass: RequestClass,
        name: string,
        fn: (rq: RequestType, _context: ServerCallContext) => Promise<Empty>
    ): void {
        this.rpcServerRegistry.registerRpcNotification(requestClass, name, fn)
    }

    private async handleRequest(rpcMessage: RpcMessage, callContext?: CallContext): Promise<void> {
        if (this.stopped) {
            return
        }
        let response: RpcMessage
        try {
            const bytes = await this.rpcServerRegistry.onRequest(rpcMessage, callContext)
            response = this.createResponseRpcMessage({
                request: rpcMessage,
                body: bytes
            })
        } catch (err) {
            let responseError
            if (err.code === ErrorCode.UNKNOWN_RPC_METHOD) {
                responseError = RpcResponseError.UNKNOWN_RPC_METHOD
            } else if (err.code === ErrorCode.RPC_TIMEOUT) {
                responseError = RpcResponseError.SERVER_TIMOUT
            } else {
                responseError = RpcResponseError.SERVER_ERROR
            }
            response = this.createResponseRpcMessage({
                request: rpcMessage,
                responseError
            })
        }
        this.onOutgoingMessage(response, undefined, callContext)
    }

    private async handleNotification(rpcMessage: RpcMessage, 
        callContext?: CallContext): Promise<void> {
        if (this.stopped) {
            return
        }
        try {
            await this.rpcServerRegistry.onNotification(rpcMessage, callContext)
        } catch (err) {
            logger.debug(err)
        }
    }

    private registerRequest(requestId: string, deferredPromises: ResultParts, timeout = this.rpcRequestTimeout): void {
        if (this.stopped) {
            return
        }
        const ongoingRequest: OngoingRequest = {
            deferredPromises,
            timeoutRef: setTimeout(() => {
                const error = new Err.RpcTimeout('Rpc request timed out', new Error())
                this.rejectDeferredPromises(deferredPromises, error, StatusCode.DEADLINE_EXCEEDED)
            }, timeout)
        }
        this.ongoingRequests.set(requestId, ongoingRequest)
    }

    private resolveOngoingRequest(response: RpcMessage): void {
        if (this.stopped) {
            return
        }
        const ongoingRequest = this.ongoingRequests.get(response.requestId)!
        if (ongoingRequest.timeoutRef) {
            clearTimeout(ongoingRequest.timeoutRef)
        }
        this.resolveDeferredPromises(ongoingRequest!.deferredPromises, response)
        this.ongoingRequests.delete(response.requestId)
    }

    private rejectOngoingRequest(response: RpcMessage): void {
        if (this.stopped) {
            return
        }
        const ongoingRequest = this.ongoingRequests.get(response.requestId)!
        if (ongoingRequest.timeoutRef) {
            clearTimeout(ongoingRequest.timeoutRef)
        }
        let error
        if (response.responseError === RpcResponseError.SERVER_TIMOUT) {
            error = new Err.RpcTimeout('Server timed out on request')
        } else if (response.responseError === RpcResponseError.UNKNOWN_RPC_METHOD) {
            error = new Err.RpcRequest(`Server does not implement method ${response.header.method}`)
        } else {
            error = new Err.RpcRequest('Server error on request')
        }
        this.rejectDeferredPromises(ongoingRequest!.deferredPromises, error, StatusCode.SERVER_ERROR)
        this.ongoingRequests.delete(response.requestId)
    }

    private rejectDeferredPromises(deferredPromises: ResultParts, error: Error, code: string): void {
        if (!this.stopped && deferredPromises.message.state === DeferredState.PENDING) {
            deferredPromises.message.reject(error)
            deferredPromises.header.reject(error)
            deferredPromises.status.reject({ code, detail: error.message })
            deferredPromises.trailer.reject(error)
        }
    }

    private resolveDeferredPromises(deferredPromises: ResultParts, response: RpcMessage): void {
        if (!this.stopped && deferredPromises.message.state === DeferredState.PENDING) {
            const parsedResponse = deferredPromises.messageParser(response.body)
            deferredPromises.message.resolve(parsedResponse)
            deferredPromises.header.resolve({})
            deferredPromises.status.resolve({ code: StatusCode.OK, detail: '' })
            deferredPromises.trailer.resolve({})
        }
    }

    private createResponseRpcMessage(
        { request, body, responseError }: { request: RpcMessage, body?: Uint8Array, responseError?: RpcResponseError }
    ): RpcMessage {
        return {
            body: body ? body : new Uint8Array(),
            header: {
                response: "response",
                method: request.header.method
            },
            requestId: request.requestId,
            responseError
        }
    }

    private createNotificationResponse(requestId: string): RpcMessage {
        const ret: Empty = {}

        const wrapper: RpcMessage = {
            body: Empty.toBinary(ret),
            header: {},
            requestId,
        }
        return wrapper
    }

    stop(): void {
        this.stopped = true
        this.ongoingRequests.forEach((ongoingRequest: OngoingRequest) => {
            clearTimeout(ongoingRequest.timeoutRef)
            this.rejectDeferredPromises(ongoingRequest.deferredPromises, new Error('stopped'), StatusCode.STOPPED)
        })
        this.removeAllListeners()
        this.ongoingRequests.clear()
        this.rpcClientTransport.stop()
        this.rpcServerRegistry.stop()
    }
}
