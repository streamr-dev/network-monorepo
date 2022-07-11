/**
 * Organises async Publish steps into a Pipeline
 */
import { EncryptionType, StreamMessage, StreamMessageType } from 'streamr-client-protocol'
import { scoped, Lifecycle, inject, delay } from 'tsyringe'

import { inspect } from '../utils/log'
import { instanceId } from '../utils/utils'
import { Defer, Deferred } from '../utils/Defer'
import { Context, ContextError } from '../utils/Context'
import { Pipeline } from '../utils/Pipeline'
import { PushPipeline } from '../utils/PushPipeline'

import { MessageCreator } from './MessageCreator'
import { BrubeckNode } from '../BrubeckNode'
import { Signer } from './Signer'
import { Encrypt } from './Encrypt'
import { Validator } from '../Validator'
import { DestroySignal } from '../DestroySignal'
import { formStreamDefinitionDescription, StreamIDBuilder } from '../StreamIDBuilder'
import { StreamDefinition } from '../types'
import { InspectOptions } from 'util'

export class FailedToPublishError extends Error {
    public publishMetadata
    public reason
    constructor(publishMetadata: PublishMetadataStrict, reason?: Error) {
        // eslint-disable-next-line max-len
        super(`Failed to publish to stream ${formStreamDefinitionDescription(publishMetadata.streamDefinition)} due to: ${reason && reason.stack ? reason.stack : reason}.`)
        this.publishMetadata = publishMetadata
        this.reason = reason
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }

    [Symbol.for('nodejs.util.inspect.custom')](depth: number, options: InspectOptions): string {
        return inspect(this, {
            ...options,
            customInspect: false,
            depth,
        })
    }
}

export interface MessageMetadata {
    timestamp?: string | number | Date
    partitionKey?: string | number,
    msgChainId?: string,
    /** @internal */
    messageType?: StreamMessageType
    /** @internal */
    encryptionType?: EncryptionType
}

// TODO better name?
export type PublishMetadata<T = unknown> = MessageMetadata & {
    content: T
}

export type PublishMetadataStrict<T = unknown> = PublishMetadata<T> & {
    timestamp: number
    streamDefinition: StreamDefinition
    partitionKey?: number | string
}

export type PublishQueueIn<T = unknown> = [PublishMetadataStrict<T>, Deferred<StreamMessage<T>>]
export type PublishQueueOut<T = unknown> = [StreamMessage<T>, Deferred<StreamMessage<T>>]

@scoped(Lifecycle.ContainerScoped)
export class PublishPipeline implements Context { // TODO: remove this class
    readonly id
    readonly debug
    /** takes metadata & creates stream messages. unsigned, unencrypted */
    private streamMessageQueue!: PushPipeline<PublishQueueIn, PublishQueueOut>
    /** signs, encrypts then publishes messages */
    private publishQueue!: Pipeline<PublishQueueOut, PublishQueueOut>
    private isStarted = false
    private isStopped = false
    private inProgress = new Set<Deferred<StreamMessage>>()

    constructor(
        context: Context,
        private node: BrubeckNode,
        private messageCreator: MessageCreator,
        private signer: Signer,
        private validator: Validator,
        private destroySignal: DestroySignal,
        private streamIdBuilder: StreamIDBuilder,
        @inject(delay(() => Encrypt)) private encryption: Encrypt,
    ) {
        this.id = instanceId(this)
        this.debug = context.debug.extend(this.id)
        this.streamMessageQueue = new PushPipeline<PublishQueueIn>()
            .pipe(this.toStreamMessage.bind(this))
            .filter(this.filterNonSettled)

        this.publishQueue = new Pipeline<PublishQueueOut>(this.streamMessageQueue)
            .forEach(this.encryptMessage.bind(this))
            .filter(this.filterNonSettled)
            .forEach(this.signMessage.bind(this))
            .filter(this.filterNonSettled)
            .forEach(this.validateMessage.bind(this))
            .filter(this.filterNonSettled)
            .forEach(this.consumeQueue.bind(this))

        destroySignal.onDestroy.listen(this.stop.bind(this))
    }

    private filterNonSettled = ([_streamMessage, defer]: PublishQueueOut): boolean => {
        if (this.isStopped && !defer.isSettled()) {
            defer.reject(new ContextError(this, 'Pipeline Stopped. Client probably disconnected'))
            return false
        }

        return !defer.isSettled()
    }

    private async* toStreamMessage(src: AsyncGenerator<PublishQueueIn>): AsyncGenerator<PublishQueueOut> {
        for await (const [publishMetadata, defer] of src) {
            const { streamDefinition, ...options } = publishMetadata
            try {
                const [streamId, partition] = await this.streamIdBuilder.toStreamPartElements(streamDefinition)
                if ((partition !== undefined) && (options.partitionKey !== undefined)) {
                    throw new Error('Invalid combination of "partition" and "partitionKey"')
                }
                options.partitionKey ??= partition
                const streamMessage = await this.messageCreator.create(streamId, options)
                yield [streamMessage, defer]
            } catch (err) {
                defer.reject(err)
                continue
            }
        }
    }

    private async encryptMessage([streamMessage, defer]: PublishQueueOut): Promise<void> {
        const onError = (err: Error) => {
            defer.reject(err)
        }

        await this.encryption.encrypt(streamMessage).catch(onError)
    }

    private async signMessage([streamMessage, defer]: PublishQueueOut): Promise<void> {
        if (defer.isSettled()) { return }
        const onError = (err: Error) => {
            defer.reject(err)
        }

        await this.signer.sign(streamMessage).catch(onError)
    }

    private async validateMessage([streamMessage, defer]: PublishQueueOut): Promise<void> {
        if (defer.isSettled()) { return }
        const onError = (err: Error) => {
            defer.reject(err)
        }

        await this.validator.validate(streamMessage).catch(onError)
    }

    private async consumeQueue([streamMessage, defer]: PublishQueueOut): Promise<void> {
        if (defer.isSettled()) { return }

        try {
            this.check()
            await this.node.publishToNode(streamMessage)
        } catch (err) {
            defer.reject(err)
        }
        defer.resolve(streamMessage)
    }

    /**
     * Starts queue if not already started.
     */
    private startQueue(): void {
        if (this.isStarted || this.isStopped) { return }

        this.isStarted = true

        this.publishQueue.consume().catch(this.debug.bind(this.debug))
    }

    check(): void {
        this.destroySignal.assertNotDestroyed(this)

        if (this.isStopped) {
            throw new ContextError(this, 'Pipeline Stopped. Client probably disconnected')
        }
    }

    /**
     * Put publish metadata into queue to be published.
     * Creates a Defer to be resolved when message gets sent to node.
     */
    async publish<T>(publishMetadata: PublishMetadataStrict<T>): Promise<StreamMessage<T>> {
        this.debug('publish >> %o', {
            streamDefinition: formStreamDefinitionDescription(publishMetadata.streamDefinition),
            timestamp: publishMetadata.timestamp,
            partitionKey: publishMetadata.partitionKey,
            msgChainId: publishMetadata.msgChainId
        })
        this.startQueue()

        const defer = Defer<StreamMessage<T>>()
        try {
            this.inProgress.add(defer)
            this.check()
            await this.streamMessageQueue.push([publishMetadata, defer])
            return await defer
        } catch (err) {
            const error = new FailedToPublishError(publishMetadata, err)
            defer.reject(error)
            throw error
        } finally {
            this.inProgress.delete(defer)
            this.debug('publish <<')
        }
    }

    start(): void {
        this.isStopped = false
    }

    async stop(): Promise<void> {
        this.debug('stop >>')
        try {
            this.isStopped = true
            const inProgress = new Set(this.inProgress)
            this.inProgress.clear()
            inProgress.forEach((defer) => {
                defer.reject(new ContextError(this, 'Pipeline Stopped. Client probably disconnected'))
            })
            this.publishQueue.return()
            this.streamMessageQueue.return()
            await Promise.allSettled([
                this.encryption.stop(),
                this.messageCreator.stop(),
            ])
        } finally {
            this.debug('stop <<')
        }
    }
}
