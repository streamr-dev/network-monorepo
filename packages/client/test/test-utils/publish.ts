import { wait } from 'streamr-test-utils'
import { StreamMessage } from 'streamr-client-protocol'

import { StreamrClient } from '../../src/StreamrClient'
import { counterId } from '../../src/utils/utils'
import { StreamDefinition } from '../../src/types'

import { PublishMetadata } from '../../src/publish/Publisher'
import { Pipeline } from '../../src/utils/Pipeline'
import { PublishPipeline } from '../../src/publish/PublishPipeline'
import { uid } from './utils'

export function Msg<T extends object = object>(opts?: T): any {
    return {
        value: uid('msg'),
        ...opts,
    }
}

export type CreateMessageOpts = {
    /** index of message in total */
    index: number,
    /** batch number */
    batch: number,
    /** index of message in batch */
    batchIndex: number,
    /** total messages */
    total: number
}

type PublishManyOpts = Partial<{
    delay: number,
    timestamp: number | (() => number)
    partitionKey: number | string | (() => number | string)
    createMessage: (content: any) => any
}>

export async function* publishManyGenerator(
    total: number = 5,
    opts: PublishManyOpts = {}
): AsyncGenerator<PublishMetadata<any>> {
    const { delay = 10, timestamp, partitionKey, createMessage = Msg } = opts
    const batchId = counterId('publishMany')
    for (let i = 0; i < total; i++) {
        yield {
            timestamp: typeof timestamp === 'function' ? timestamp() : timestamp,
            partitionKey: typeof partitionKey === 'function' ? partitionKey() : partitionKey,
            content: createMessage({
                batchId,
                value: `${i + 1} of ${total}`,
                index: i,
                total,
            })
        }

        if (delay) {
            // eslint-disable-next-line no-await-in-loop
            await wait(delay)
        }
    }
}

type PublishTestMessageOptions = PublishManyOpts & {
    waitForLast?: boolean
    waitForLastCount?: number
    waitForLastTimeout?: number,
    retainMessages?: boolean
    afterEach?: (msg: StreamMessage) => Promise<void> | void
}

export function publishTestMessagesGenerator(
    client: StreamrClient,
    streamDefinition: StreamDefinition,
    maxMessages = 5,
    opts: PublishTestMessageOptions = {}
): Pipeline<StreamMessage<unknown>, StreamMessage<unknown>> {
    const source = new Pipeline(publishManyGenerator(maxMessages, opts))
    const pipeline = new Pipeline<StreamMessage>(publishFromMetadata(streamDefinition, source, client))
    if (opts.afterEach) {
        pipeline.forEach(opts.afterEach)
    }
    return pipeline
}

export function getPublishTestStreamMessages(
    client: StreamrClient,
    streamDefinition: StreamDefinition,
    defaultOpts: PublishTestMessageOptions = {}
): (maxMessages?: number, opts?: PublishTestMessageOptions) => Promise<StreamMessage<unknown>[]> {
    return async (maxMessages: number = 5, opts: PublishTestMessageOptions = {}) => {
        const {
            waitForLast,
            waitForLastCount,
            waitForLastTimeout,
            retainMessages = true,
            ...options
        } = {
            ...defaultOpts,
            ...opts,
        }

        const contents = new WeakMap()
        // @ts-expect-error private
        const publishPipeline = client.container.resolve(PublishPipeline)
        // @ts-expect-error private
        publishPipeline.streamMessageQueue.onMessage.listen(([streamMessage]) => {
            contents.set(streamMessage, streamMessage.serializedContent)
        })
        const publishStream = publishTestMessagesGenerator(client, streamDefinition, maxMessages, options)
        const streamMessages = []
        let count = 0
        for await (const streamMessage of publishStream) {
            count += 1
            if (!retainMessages) {
                streamMessages.length = 0 // only keep last message
            }
            streamMessages.push(streamMessage)
            if (count === maxMessages) {
                break
            }
        }

        if (waitForLast) {
            await getWaitForStorage(client, {
                count: waitForLastCount,
                timeout: waitForLastTimeout,
            })(streamMessages[streamMessages.length - 1])
        }

        return streamMessages.map((streamMessage) => {
            const targetStreamMessage = streamMessage.clone()
            targetStreamMessage.serializedContent = contents.get(streamMessage)
            targetStreamMessage.encryptionType = 0
            targetStreamMessage.parsedContent = null
            targetStreamMessage.getParsedContent()
            return targetStreamMessage
        })
    }
}

export function getPublishTestMessages(
    client: StreamrClient,
    streamDefinition: StreamDefinition,
    defaultOpts: PublishTestMessageOptions = {}
): (maxMessages?: number, opts?: PublishTestMessageOptions) => Promise<unknown[]> {
    const publishTestStreamMessages = getPublishTestStreamMessages(client, streamDefinition, defaultOpts)
    return async (maxMessages: number = 5, opts: PublishTestMessageOptions = {}) => {
        const streamMessages = await publishTestStreamMessages(maxMessages, opts)
        return streamMessages.map((s) => s.getParsedContent())
    }
}

export async function* publishFromMetadata<T>(
    streamDefinition: StreamDefinition, 
    seq: AsyncIterable<PublishMetadata<T>>,
    client: StreamrClient
): AsyncGenerator<StreamMessage<T>, void, unknown> {
    for await (const msg of seq) {
        yield await client.publish(streamDefinition, msg.content, {
            timestamp: msg.timestamp,
            partitionKey: msg.partitionKey
        })
    }
}

export function getWaitForStorage(client: StreamrClient, defaultOpts = {}): (lastPublished: StreamMessage, opts?: {
    interval?: number
    timeout?: number
    count?: number
    messageMatchFn?: (msgTarget: StreamMessage, msgGot: StreamMessage) => boolean
}) => Promise<void> {
    return async (lastPublished: StreamMessage, opts = {}) => {
        return client.waitForStorage(lastPublished, {
            ...defaultOpts,
            ...opts,
        })
    }
}
