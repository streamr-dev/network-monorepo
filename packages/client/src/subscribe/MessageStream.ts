/**
 * Wrapper around PushPipeline specific to StreamMessages.
 * Subscriptions are MessageStreams.
 * Not all MessageStreams are Subscriptions.
 */
import { PipelineTransform } from '../utils/Pipeline'
import { PushPipeline } from '../utils/PushPipeline'
import { instanceId } from '../utils'
import { Context } from '../utils/Context'
import { StreamMessage } from 'streamr-client-protocol'
import * as G from '../utils/GeneratorUtils'

export type MessageStreamOnMessage<T, R = unknown> = (msg: T, streamMessage: StreamMessage<T>) => R | Promise<R>

export type MessageStreamOptions = {
    bufferSize?: number
    name?: string
}

export class MessageStream<
    T = unknown,
    InType = StreamMessage<T>,
    OutType extends StreamMessage<T> | unknown = InType
> extends PushPipeline<InType, OutType> {
    /** @internal */
    constructor(context: Context, { bufferSize, name = '' }: MessageStreamOptions = {}) {
        super(bufferSize)
        this.id = instanceId(this, name)
        this.debug = context.debug.extend(this.id)
    }

    /**
     * Attach a legacy onMessage handler and consume if necessary.
     * onMessage is passed parsed content as first arument, and streamMessage as second argument.
     * @internal
     */
    useLegacyOnMessageHandler(onMessage?: MessageStreamOnMessage<T>): this {
        if (onMessage) {
            this.onMessage.listen(async (streamMessage) => {
                if (streamMessage instanceof StreamMessage) {
                    await onMessage(streamMessage.getParsedContent(), streamMessage)
                }
            })
        }
        this.flow()

        return this
    }

    /** @internal */
    async collectContent(n?: number): Promise<any[]> {
        const messages = await this.collect(n)
        return messages.map((streamMessage) => {
            if (streamMessage instanceof StreamMessage) {
                return streamMessage.getParsedContent()
            }
            return streamMessage
        })
    }

    /** @internal */
    pipe<NewOutType>(fn: PipelineTransform<OutType, NewOutType>): MessageStream<T, InType, NewOutType> {
        // this method override just fixes the output type to be MessageStream rather than Pipeline
        super.pipe(fn)
        return this as MessageStream<T, InType, unknown> as MessageStream<T, InType, NewOutType>
    }

    /** @internal */
    pipeBefore(fn: PipelineTransform<InType, InType>): MessageStream<T, InType, OutType> {
        // this method override just fixes the output type to be MessageStream rather than Pipeline
        super.pipeBefore(fn)
        return this
    }

    /** @internal */
    map<NewOutType>(fn: G.GeneratorMap<OutType, NewOutType>): MessageStream<T, InType, NewOutType> {
        // this method override just fixes the output type to be MessageStream rather than Pipeline
        return super.map(fn) as MessageStream<T, InType, NewOutType>
    }

    /** @internal */
    filterBefore(fn: G.GeneratorFilter<InType>): MessageStream<T, InType, OutType> {
        // this method override just fixes the output type to be MessageStream rather than Pipeline
        return super.filterBefore(fn) as MessageStream<T, InType, OutType>
    }

    /** @internal */
    filter(fn: G.GeneratorFilter<OutType>): MessageStream<T, InType, OutType> {
        // this method override just fixes the output type to be MessageStream rather than Pipeline
        return super.filter(fn) as MessageStream<T, InType, OutType>
    }

    /** @internal */
    forEach(fn: G.GeneratorForEach<OutType>): MessageStream<T, InType, OutType> {
        // this method override just fixes the output type to be MessageStream rather than Pipeline
        return super.forEach(fn) as MessageStream<T, InType, OutType>
    }

    /** @internal */
    forEachBefore(fn: G.GeneratorForEach<InType>): MessageStream<T, InType, OutType> {
        // this method override just fixes the output type to be MessageStream rather than Pipeline
        return super.forEachBefore(fn) as MessageStream<T, InType, OutType>
    }

    async unsubscribe(): Promise<void> {
        this.end()
        await this.return()
    }
}

export async function pullManyToOne<T>(
    context: Context,
    inputStreams: MessageStream<T>[],
    onMessage?: MessageStreamOnMessage<T>,
    onError?: (err: Error) => void
): Promise<MessageStream<T, StreamMessage<T>, StreamMessage<T>>> {
    if (inputStreams.length === 1) {
        if (onMessage) {
            inputStreams[0].useLegacyOnMessageHandler(onMessage)
        }
        return inputStreams[0]
    }

    // output stream
    const outputStream = new MessageStream<T>(context)

    if (onMessage) {
        outputStream.useLegacyOnMessageHandler(onMessage)
    }

    if (onError) {
        outputStream.onError.listen(onError)
    }

    // pull inputStreams into output stream
    let onFinallyCount = 0
    let onFinallyError: Error | undefined
    for (const sub of inputStreams) {
        sub.onFinally.listen((err?: Error | void) => {
            if (err && (onFinallyError === undefined)) {
                onFinallyError = err
            }
            // eslint-disable-next-line no-plusplus
            onFinallyCount++
            if (onFinallyCount === inputStreams.length) {
                outputStream.endWrite(onFinallyError)
            }
        })
        sub.onError.listen((err) => outputStream.handleError(err))
        outputStream.pull(sub, { endDest: false })
    }
    return outputStream
}
