/**
 * MessageChains
 */
import {
    MessageRef,
    MessageID,
    StreamPartID,
    StreamID,
    StreamPartIDUtils,
    EthereumAddress
} from 'streamr-client-protocol'
import { CacheConfig } from '../Config'
import { randomString } from '../utils/utils'
import { CacheFn } from '../utils/caches'

export type MessageChainOptions = {
    publisherId: EthereumAddress
    msgChainId?: string
}

export function getCachedMessageChain(cacheConfig?: CacheConfig):
    ((streamPartId: StreamPartID, msgChainOptions: MessageChainOptions) => MessageChain) & {
    clearMatching: (matchFn: (key: string) => boolean) => void
} {
    // one chainer per streamId + streamPartition + publisherId + msgChainId
    return CacheFn((...args: ConstructorParameters<typeof MessageChain>) => new MessageChain(...args), {
        cacheKey: ([streamPartId, { publisherId, msgChainId }]) => (
            // empty msgChainId is fine
            [streamPartId, publisherId, msgChainId ?? ''].join('|')
        ),
        ...cacheConfig,
        maxAge: Infinity
    })
}

/**
 * Manage sequenceNumber & msgChainId for StreamMessages
 */
export class MessageChain {
    private readonly streamId: StreamID
    private readonly streamPartition: number
    private readonly publisherId: string
    private readonly msgChainId: string
    private prevMsgRef?: MessageRef

    constructor(streamPartId: StreamPartID, { publisherId, msgChainId = randomString(20) }: MessageChainOptions) {
        [this.streamId, this.streamPartition] = StreamPartIDUtils.getStreamIDAndPartition(streamPartId)
        this.publisherId = publisherId
        this.msgChainId = msgChainId
    }

    /**
     * Generate the next message MessageID + previous MessageRef for this message chain.
     * Messages with same timestamp get incremented sequence numbers.
     */
    add(timestamp: number): [MessageID, MessageRef | undefined] {
        const { prevMsgRef, publisherId, msgChainId, streamId, streamPartition } = this
        // NOTE: publishing back-dated (i.e. non-sequentially timestamped) messages will 'break' sequencing.
        // i.e. we lose track of biggest sequence number whenever timestamp changes for stream id+partition combo
        // so backdated messages will start at sequence 0 again, regardless of the sequencing of existing messages.
        // storage considers timestamp+sequence number unique, so the newer messages will clobber the older messages
        // Not feasible to keep greatest sequence number for every millisecond timestamp so not sure a good way around this.
        // Possible we should keep a global sequence number
        const isSameTimestamp = prevMsgRef && prevMsgRef.timestamp === timestamp
        const isBackdated = prevMsgRef && prevMsgRef.timestamp > timestamp
        // increment if timestamp the same, otherwise 0
        const nextSequenceNumber = isSameTimestamp ? prevMsgRef!.sequenceNumber + 1 : 0
        const messageId = new MessageID(streamId, streamPartition, timestamp, nextSequenceNumber, publisherId, msgChainId)
        // update latest timestamp + sequence for this streamId+partition
        // (see note above about clobbering sequencing)
        // don't update latest if timestamp < previous timestamp
        // this "fixes" the sequence breaking issue above, but this message will silently disappear
        const currentPrevMsgRef = prevMsgRef
        if (!isBackdated) {
            this.prevMsgRef = new MessageRef(timestamp, nextSequenceNumber)
        }
        return [messageId, currentPrevMsgRef]
    }
}
