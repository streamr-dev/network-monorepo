import { FifoMapWithTtl } from '../logic/propagation/FifoMapWithTtl'
import { NodeId } from '../identifiers'
import { ControlMessage, TrackerMessage } from 'streamr-client-protocol'
import EventEmitter from 'events'

export type RemoveHandlerAfter = boolean

export type ResponseHandlerFn<M> = (message: M, source: NodeId) => RemoveHandlerAfter

export class ResponseAwaiter<M extends (TrackerMessage | ControlMessage)> {
    private readonly registeredHandlers = new FifoMapWithTtl<string, ResponseHandlerFn<M>>({
        ttlInMs: 5 * 60 * 1000,
        maxSize: 1000
    })

    constructor(emitter: EventEmitter, events: ReadonlyArray<string>) {
        for (const event of events) {
            emitter.on(event, this.fireHandlerIfRegistered)
        }
    }

    register(requestId: string, responseHandler: ResponseHandlerFn<M>): void {
        this.registeredHandlers.set(requestId, responseHandler)
    }

    private fireHandlerIfRegistered = (message: M, source: NodeId) => {
        const requestId = message.requestId
        const responseHandler = this.registeredHandlers.get(requestId)
        if (responseHandler !== undefined) {
            const shouldRemove = responseHandler(message, source)
            if (shouldRemove) {
                this.registeredHandlers.delete(requestId)
            }
        }
    }
}
