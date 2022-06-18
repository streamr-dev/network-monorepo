import { EventEmitter } from 'events'

import Debug from 'debug'
import Heap from 'heap'
import StrictEventEmitter from 'strict-event-emitter-types'

import GapFillFailedError from '../errors/GapFillFailedError'
import MessageRef from '../protocol/message_layer/MessageRef'

import StreamMessage from '../protocol/message_layer/StreamMessage'

function toMsgRefId(streamMessage: StreamMessage): MsgRefId {
    return streamMessage.getMessageRef().serialize()
}

type MsgRefId = string

type ChainedMessage = StreamMessage & { prevMsgRef: NonNullable<StreamMessage['prevMsgRef']>}

/**
 * Set of StreamMessages, unique by serialized msgRef i.e. timestamp + sequence number.
 */
class StreamMessageSet {
    msgMap = new Map<MsgRefId, StreamMessage>()

    has(streamMessage: StreamMessage) {
        return this.msgMap.has(toMsgRefId(streamMessage))
    }

    /**
     * Get StreamMessage associated with this msgRef
     */
    get(msgRef: MessageRef) {
        return this.msgMap.get(msgRef.serialize())
    }

    delete(streamMessage: StreamMessage) {
        return this.msgMap.delete(toMsgRefId(streamMessage))
    }

    add(streamMessage: StreamMessage) {
        if (!this.has(streamMessage)) {
            return this.msgMap.set(toMsgRefId(streamMessage), streamMessage)
        }
        return this
    }

    size() {
        return this.msgMap.size
    }
}

/**
 * Ordered queue of StreamMessages.
 * Deduplicated by serialized msgRef.
 */
class MsgChainQueue {

    /**
     * Ordered message refs
     */
    private queue = new Heap<MessageRef>((msg1: MessageRef, msg2: MessageRef) => {
        return msg1.compareTo(msg2)
    })

    /**
     * Mapping from msgRef to message.
     */
    private pendingMsgs = new StreamMessageSet()

    /**
     * Peek at next message in-order.
     */
    peek() {
        if (this.isEmpty()) { return }
        const ref = this.queue.peek()
        return this.pendingMsgs.get(ref as MessageRef)
    }

    /**
     * True if queue already has a message with this message ref.
     */
    has(streamMessage: StreamMessage): boolean {
        // prevent duplicates
        return this.pendingMsgs.has(streamMessage)
    }

    /**
     * Push new item into the queue.
     * Ignores duplicates.
     */
    push(streamMessage: StreamMessage): void {
        // prevent duplicates
        if (this.has(streamMessage)) { return }
        this.pendingMsgs.add(streamMessage)
        const msgRef = streamMessage.getMessageRef()
        this.queue.push(msgRef)
    }

    /**
     * Remove next item from queue and return it.
     */
    pop(): StreamMessage | undefined {
        if (this.isEmpty()) { return }
        const streamMessage = this.peek()
        if (!streamMessage) { return }
        this.queue.pop()
        this.pendingMsgs.delete(streamMessage)
        return streamMessage
    }

    /**
     * True if there are no items in the queue.
     */
    isEmpty(): boolean {
        return this.queue.empty()
    }

    /**
     * Number of items in queue.
     */
    size(): number {
        return this.queue.size()
    }
}

export type MessageHandler = (msg: StreamMessage) => void
export type GapHandler = (from: MessageRef, to: MessageRef, publisherId: string, msgChainId: string) => void | Promise<void>

/**
 * Strict types for EventEmitter interface.
 */
interface Events {
    /**
     * Message was marked and is being skipped.
     * Does not fire if maxGapRequests = 0
     */
    skip: MessageHandler;
    /**
     * Queue was drained after something was in it.
     */
    drain: (numMessages: number) => void;
    /**
     * Probably a GapFillFailedError.
     */
    error: (error: Error) => void;
}

export const MsgChainEmitter = EventEmitter as { new(): StrictEventEmitter<EventEmitter, Events> }

// The time it takes to propagate messages in the network. If we detect a gap, we first wait this amount of time because the missing
// messages might still be propagated.
const DEFAULT_PROPAGATION_TIMEOUT = 5000
// The round trip time it takes to request a resend and receive the answer. If the messages are still missing after the propagation
// delay, we request a resend and periodically wait this amount of time before requesting it again.
const DEFAULT_RESEND_TIMEOUT = 5000
const MAX_GAP_REQUESTS = 10

let ID = 0

class OrderedMsgChain extends MsgChainEmitter {
    id: number
    queue = new MsgChainQueue()
    lastOrderedMsgRef: MessageRef | null = null
    hasPendingGap = false
    gapRequestCount = 0
    maxGapRequests: number
    publisherId: string
    msgChainId: string
    inOrderHandler: MessageHandler
    gapHandler: GapHandler
    propagationTimeout: number
    resendTimeout: number
    nextGaps: ReturnType<typeof setTimeout> | null = null
    markedExplicitly = new StreamMessageSet()
    debug: ReturnType<typeof Debug>

    constructor(
        publisherId: string, msgChainId: string, inOrderHandler: MessageHandler, gapHandler: GapHandler,
        propagationTimeout = DEFAULT_PROPAGATION_TIMEOUT, resendTimeout = DEFAULT_RESEND_TIMEOUT, maxGapRequests = MAX_GAP_REQUESTS
    ) {
        super()
        ID += 1
        this.id = ID
        this.debug = Debug(`StreamrClient::OrderedMsgChain::${this.id}::${msgChainId}`)
        this.publisherId = publisherId
        this.msgChainId = msgChainId
        this.inOrderHandler = inOrderHandler
        this.gapHandler = gapHandler
        this.lastOrderedMsgRef = null
        this.propagationTimeout = propagationTimeout
        this.resendTimeout = resendTimeout
        this.maxGapRequests = maxGapRequests

        if (!this.isGapHandlingEnabled()) {
            this.debug('Gap handling disabled for this %s.', this.constructor.name)
        }
    }

    /**
     * Messages are stale if they are already enqueued or last ordered message is newer.
     */
    isStaleMessage(streamMessage: StreamMessage): boolean {
        const msgRef = streamMessage.getMessageRef()
        return !!(
            // already enqueued
            this.queue.has(streamMessage) || (
                this.lastOrderedMsgRef
                // or older/equal to last ordered msgRef
                && msgRef.compareTo(this.lastOrderedMsgRef) <= 0
            )
        )
    }

    /**
     * Add message to queue.
     */
    add(unorderedStreamMessage: StreamMessage): void {
        if (this.isStaleMessage(unorderedStreamMessage)) {
            const msgRef = unorderedStreamMessage.getMessageRef()
            // Prevent double-processing of messages for any reason
            this.debug(
                'Ignoring message: %o. Message was already enqueued or we already processed a newer message: %o.',
                msgRef,
                this.lastOrderedMsgRef
            )
            return
        }

        // gap handling disabled
        if (!this.isGapHandlingEnabled()) {
            this.markMessage(unorderedStreamMessage)
        }

        this.queue.push(unorderedStreamMessage)
        this.checkQueue()
    }

    /**
     * Mark a message to have it be treated as the next message & not trigger gap fill
     */
    markMessageExplicitly(streamMessage: StreamMessage): void {
        // only add if not stale
        if (this.markMessage(streamMessage)) {
            this.add(streamMessage)
        }
    }

    /**
     * Adds message to set of marked messages.
     * Does nothing and returns false if message is stale.
     */
    private markMessage(streamMessage: StreamMessage): boolean {
        if (!streamMessage || this.isStaleMessage(streamMessage)) {
            // do nothing if already past/handled this message
            return false
        }

        if (this.isGapHandlingEnabled()) {
            this.debug('marking message', streamMessage.getMessageRef())
        }

        this.markedExplicitly.add(streamMessage)
        return true
    }

    /**
     * Cancel any outstanding gap fill request.
     */
    clearGap(): void {
        if (this.hasPendingGap) {
            this.debug('clearGap')
        }
        this.hasPendingGap = false
        clearTimeout(this.nextGaps!)
        this.nextGaps = null
    }

    disable(): void {
        this.maxGapRequests = 0
        this.clearGap()
        this.checkQueue()
    }

    isGapHandlingEnabled(): boolean {
        return this.maxGapRequests > 0
    }

    /**
     * True if queue is empty.
     */
    isEmpty(): boolean {
        return this.queue.isEmpty()
    }

    /**
     * Number of enqueued messages.
     */
    size(): number {
        return this.queue.size()
    }

    /**
     * True if the next queued message is the next message in the chain.
     * Always true for first message and unchained messages i.e. messages without a prevMsgRef.
     */
    private hasNextMessageInChain(): boolean {
        const streamMessage = this.queue.peek()
        if (!streamMessage) { return false }
        const { prevMsgRef } = streamMessage
        // is first message
        if (this.lastOrderedMsgRef === null) { return true }
        if (prevMsgRef !== null) {
            // if has prev, message is chained: ensure prev points at last ordered message
            return prevMsgRef.compareTo(this.lastOrderedMsgRef) === 0
        } else {
            // without prev, message is unchained.
            // only first message in chain should have no prev
            // This assumes it's the next message if it's newer
            // and relies on queue pre-sorting messages
            return streamMessage.getMessageRef().compareTo(this.lastOrderedMsgRef) > 0
        }
    }

    /**
     * Keep popping messages until we hit a gap or run out of messages.
     */
    private checkQueue(): void {
        let processedMessages = 0
        while (this.hasNextMessageInChain()) {
            processedMessages += 1
            this.pop()
        }

        // if queue not empty then we have a gap
        if (!this.queue.isEmpty()) {
            this.scheduleGap()
            return
        }

        // emit drain after clearing a block. If only a single item was in the
        // queue, the queue was never blocked, so it doesn't need to 'drain'.
        if (processedMessages > 1) {
            this.debug('queue drained', processedMessages, this.lastOrderedMsgRef)
            this.clearGap()
            this.emit('drain', processedMessages)
        }
    }

    /**
     * Remove next message from queue and run it through inOrderHandler if valid.
     */
    private pop(): StreamMessage | undefined {
        const msg = this.queue.pop()
        if (!msg) { return }
        this.lastOrderedMsgRef = msg.getMessageRef()
        try {
            if (this.markedExplicitly.has(msg)) {
                this.markedExplicitly.delete(msg)

                if (this.isGapHandlingEnabled()) {
                    this.debug('skipping message', msg.getMessageRef())
                    this.emit('skip', msg)
                    return msg
                }
            }

            this.inOrderHandler(msg)
        } catch (err: any) {
            this.emit('error', err)
        }
        return msg
    }

    /**
     * Schedule a requestGapFill call.
     */
    private scheduleGap(): void {
        if (this.hasPendingGap) { return }

        this.gapRequestCount = 0
        this.hasPendingGap = true

        if (!this.isGapHandlingEnabled()) {
            this.onGapFillsExhausted()
            return
        }

        this.debug('scheduleGap in %dms', this.propagationTimeout)
        const nextGap = (timeout: number) => {
            clearTimeout(this.nextGaps!)
            this.nextGaps = setTimeout(async () => {
                if (!this.hasPendingGap) { return }
                await this.requestGapFill()
                if (!this.hasPendingGap) { return }
                nextGap(this.resendTimeout)
            }, timeout)
        }
        nextGap(this.propagationTimeout)
    }

    /**
     * Call gapHandler until run out of gapRequests.
     * Failure emits an error and sets up to continue processing enqueued messages after the gap.
     */
    private async requestGapFill(): Promise<void> {
        if (!this.hasPendingGap || this.isEmpty()) { return }
        const msg = this.queue.peek() as ChainedMessage
        const { lastOrderedMsgRef } = this
        if (!msg || !lastOrderedMsgRef) { return }
        // Note: msg will always have a prevMsgRef at this point. First message
        // & unchained messages won't trigger gapfill i.e. Only chained
        // messages (messages with a prevMsgRef) can block queue processing.
        // Unchained messages arriving after queue is blocked will get
        // processed immediately if they sort earlier than the blocking message
        // or they will get queued behind the chained message and will be
        // processed unconditionally as soon as the queue is unblocked.
        const to = msg.prevMsgRef
        const from = new MessageRef(lastOrderedMsgRef.timestamp, lastOrderedMsgRef.sequenceNumber + 1)
        const { gapRequestCount, maxGapRequests } = this
        if (gapRequestCount < maxGapRequests) {
            this.debug('requestGapFill %d of %d: %o', gapRequestCount + 1, maxGapRequests, {
                from,
                to,
            })
            this.gapRequestCount += 1
            try {
                await this.gapHandler(from, to, this.publisherId, this.msgChainId)
            } catch (err: any) {
                this.emit('error', err)
            }
        } else {
            this.onGapFillsExhausted()
        }
    }

    private onGapFillsExhausted() {
        if (!this.hasPendingGap || this.isEmpty()) { return }
        const { maxGapRequests } = this
        const msg = this.queue.peek() as ChainedMessage
        const { lastOrderedMsgRef } = this
        if (!msg || !lastOrderedMsgRef) { return }

        const to = msg.prevMsgRef
        const from = new MessageRef(lastOrderedMsgRef.timestamp, lastOrderedMsgRef.sequenceNumber + 1)
        if (this.isGapHandlingEnabled()) {
            this.debug('requestGapFill failed after %d attempts: %o', maxGapRequests, {
                from,
                to,
            })
            this.debugStatus()
        }

        // skip gap, allow queue processing to continue
        this.lastOrderedMsgRef = msg.getPreviousMessageRef()
        if (this.isGapHandlingEnabled()) {
            this.emit('error', new GapFillFailedError(from, to, this.publisherId, this.msgChainId, maxGapRequests))
        }

        this.clearGap()
        // keep processing
        this.checkQueue()

    }

    debugStatus(): void {
        this.debug('Up to %o: %o', this.lastOrderedMsgRef, {
            gapRequestCount: this.gapRequestCount,
            maxGapRequests: this.maxGapRequests,
            size: this.queue.size(),
            isEmpty: this.isEmpty(),
            hasPendingGap: this.hasPendingGap,
            markedExplicitly: this.markedExplicitly.size()
        })
    }
}

export default OrderedMsgChain
