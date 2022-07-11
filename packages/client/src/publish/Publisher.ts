/**
 * Public Publishing API
 */
import { KeyExchangeStreamIDUtils, StreamID, StreamMessage } from 'streamr-client-protocol'
import { scoped, Lifecycle, delay, inject } from 'tsyringe'
import pMemoize from 'p-memoize'
import { instanceId } from '../utils/utils'
import { Context } from '../utils/Context'
import { MessageMetadata, PublishMetadata } from './PublishPipeline'
import { StreamDefinition } from '../types'
import { StreamIDBuilder } from '../StreamIDBuilder'
import { Authentication, AuthenticationInjectionToken } from '../Authentication'
import { BrubeckNode } from '../BrubeckNode'
import { MessageFactory } from './MessageFactory'
import { isString } from 'lodash'
import { StreamRegistryCached } from '../registry/StreamRegistryCached'
import { CacheConfig, ConfigInjectionToken } from '../Config'
import { PublisherKeyExchange } from '../encryption/PublisherKeyExchange'
import { pLimitFn } from '../utils/promises'
import { Validator } from '../Validator'

export type { PublishMetadata }

const parseTimestamp = (metadata?: MessageMetadata): number => {
    if (metadata?.timestamp === undefined) {
        return Date.now()
    } else {
        return metadata.timestamp instanceof Date
            ? metadata.timestamp.getTime()
            : isString(metadata.timestamp)
                ? new Date(metadata.timestamp).getTime()
                : metadata.timestamp
    }
}

@scoped(Lifecycle.ContainerScoped)
export class Publisher implements Context {
    readonly id
    readonly debug
    private streamIdBuilder: StreamIDBuilder
    private authentication: Authentication
    private streamRegistryCached: StreamRegistryCached
    private keyExchange: PublisherKeyExchange
    private node: BrubeckNode
    private cacheConfig: CacheConfig
    private getMessageFactory: (streamId: StreamID) => Promise<MessageFactory>
    private validator: Validator

    constructor(
        context: Context,
        streamIdBuilder: StreamIDBuilder,
        @inject(AuthenticationInjectionToken) authentication: Authentication,
        streamRegistryCached: StreamRegistryCached,
        @inject(delay(() => PublisherKeyExchange)) keyExchange: PublisherKeyExchange,
        node: BrubeckNode,
        validator: Validator,
        @inject(ConfigInjectionToken.Cache) cacheConfig: CacheConfig
    ) {
        this.id = instanceId(this)
        this.debug = context.debug.extend(this.id)
        this.streamIdBuilder = streamIdBuilder
        this.authentication = authentication
        this.streamRegistryCached = streamRegistryCached
        this.keyExchange = keyExchange
        this.node = node
        this.cacheConfig = cacheConfig
        this.getMessageFactory = pLimitFn(pMemoize(async (streamId: StreamID) => {  // TODO is it better to use pMemoize or CacheAsyncFn (e.g. after revoked publish permissions?)
            return this.createMessageFactory(streamId)
        }, {
            cacheKey: ([streamId]) => streamId
        }))
        this.validator = validator
    }

    private async createMessageFactory(streamId: StreamID): Promise<MessageFactory> {
        // TODO if the publish() calls in KeyExchangeStream use BrubeckNode directly, we can remove this exception
        // In that case we can also remove the 2 internal fields of MessageMetadata as there is no need to support those in normal publishing
        if (KeyExchangeStreamIDUtils.isKeyExchangeStream(streamId)) {
            const authenticatedUser = await this.authentication.getAddress()
            return new MessageFactory({
                streamId: streamId,
                partitionCount: 1,
                isPublicStream: true,
                publisherId: authenticatedUser.toLowerCase(),
                createSignature: (payload: string) => this.authentication.createMessagePayloadSignature(payload),
                useGroupKey: () => Promise.reject(),
                cacheConfig: this.cacheConfig,
                validator: this.validator
            })
        }
        const [ stream, authenticatedUser ] = await Promise.all([
            this.streamRegistryCached.getStream(streamId),
            this.authentication.getAddress()
        ])
        const isPublisher = await this.streamRegistryCached.isStreamPublisher(streamId, authenticatedUser)
        if (!isPublisher) {
            throw new Error(`${authenticatedUser} is not a publisher on stream ${streamId}`)
        }
        const isPublicStream = await this.streamRegistryCached.isPublic(streamId)
        return new MessageFactory({
            streamId,
            partitionCount: stream.partitions,
            isPublicStream,
            publisherId: authenticatedUser.toLowerCase(),
            createSignature: (payload: string) => this.authentication.createMessagePayloadSignature(payload),
            useGroupKey: pLimitFn(() => this.keyExchange.useGroupKey(streamId), 1), // if we add concurrency support to GroupKeyStore (used by PublisherKeyExchange), we can remove this pLimit
            cacheConfig: this.cacheConfig,
            validator: this.validator
        })
    }

    async publish<T>(
        streamDefinition: StreamDefinition,
        content: T,
        metadata?: MessageMetadata
    ): Promise<StreamMessage<T>> {
        const timestamp = parseTimestamp(metadata)
        const [ streamId, partition ] = await this.streamIdBuilder.toStreamPartElements(streamDefinition)
        const messageFactory = await this.getMessageFactory(streamId)
        const message = await messageFactory.createMessage(
            partition,
            content,
            {
                ...metadata,
                timestamp
            }
        )
        await this.node.publishToNode(message)
        return message
    }
}
