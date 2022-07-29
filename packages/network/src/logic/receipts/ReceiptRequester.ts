import { BucketCollector } from './BucketCollector'
import { NodeId } from '../../identifiers'
import { DebouncedTaskManager, Logger } from '@streamr/utils'
import { Bucket, BucketID, getWindowStartTime, WINDOW_LENGTH } from './Bucket'
import { Event, NodeToNode } from '../../protocol/NodeToNode'
import { Claim, ReceiptRequest, StreamPartIDUtils } from 'streamr-client-protocol'
import { v4 as uuidv4 } from 'uuid'
import { Signers } from './SignatureFunctions'
import { ReceiptStore } from './ReceiptStore'

const DEFAULT_WINDOW_TIMEOUT_MARGIN = WINDOW_LENGTH  // TODO: define production value
const DEFAULT_UPDATE_TIMEOUT_MARGIN = WINDOW_LENGTH  // TODO: define production value

const logger = new Logger(module)

export interface ConstructorOptions {
    myNodeId: NodeId
    nodeToNode: Pick<NodeToNode, 'on' | 'send' | 'registerErrorHandler'>
    receiptStore: ReceiptStore
    signers: Signers
    windowTimeoutMargin?: number
    bucketUpdateTimeoutMargin?: number
}

/**
 * Plays the active role of the receipt requester.
 *
 * When a bucket is closed (due to window timeout or bucket update timeout),
 * this class will send a receipt request to the counterparty node in order to
 * establish a common ground truth on the amount of stream message data this
 * node has sent and what the counterparty has received during the window.
 *
 * It will then wait for a response, and upon receiving such, will perform
 * signature validations and such. If everything looks good, it will ask
 * `ReceiptStore` to store the receipt.
 */
export class ReceiptRequester {
    private readonly myNodeId: NodeId
    private readonly nodeToNode: Pick<NodeToNode, 'on' | 'send' | 'registerErrorHandler'>
    private readonly receiptStore: ReceiptStore
    private readonly signers: Signers
    private readonly windowTimeoutMargin: number
    private readonly bucketUpdateTimeoutMargin: number
    private readonly debouncedTasks = new DebouncedTaskManager<BucketID>()
    private readonly collector = new BucketCollector((bucket) => {
        this.debouncedTasks.schedule(bucket.getId(), this.getCloseTime(bucket) - Date.now(), () => {
            this.sendReceiptRequest(bucket)
            this.collector.removeBucket(bucket.getId())
            logger.info('closed bucket %s', bucket.getId())
        })
    })

    constructor({
        myNodeId,
        nodeToNode,
        receiptStore,
        signers,
        windowTimeoutMargin,
        bucketUpdateTimeoutMargin
    }: ConstructorOptions) {
        this.myNodeId = myNodeId
        this.nodeToNode = nodeToNode
        this.receiptStore = receiptStore
        this.signers = signers
        this.windowTimeoutMargin = windowTimeoutMargin || DEFAULT_WINDOW_TIMEOUT_MARGIN
        this.bucketUpdateTimeoutMargin = bucketUpdateTimeoutMargin || DEFAULT_UPDATE_TIMEOUT_MARGIN

        nodeToNode.on(Event.BROADCAST_MESSAGE_SENT, ({ streamMessage }, recipient) => {
            this.collector.record(streamMessage, recipient)
        })
        nodeToNode.on(Event.RECEIPT_RESPONSE_RECEIVED, ({ receipt }, source) => {
            const { receiver, sender } = receipt.claim
            if (receiver !== source) { // TODO: This is not necessarily wrong, however, why would these get relayed thru a 3rd party?
                logger.warn('unexpected receipt from %s (trying to respond on behalf of %s)', source, receiver)
                // TODO: cut connection?
                return
            }
            if (sender !== this.myNodeId) {
                logger.warn('unexpected receipt from %s (the claim directed to %s does not concern me)',
                    source, sender)
                // TODO: cut connection?
                return
            }
            if (!this.signers.receipt.validate(receipt)) {
                logger.warn('receipt from %s has invalid signature', source)
                // TODO: cut connection?
                return
            }
            if (!this.signers.claim.validate(receipt.claim)) {
                logger.warn('receipt.claim from %s has invalid signature', source)
                // TODO: cut connection?
                return
            }
            this.receiptStore.store(receipt)
            logger.info("Accepted receipt %j", receipt)
        })
    }

    stop(): void {
        this.debouncedTasks.unscheduleAll()
    }

    private sendReceiptRequest(bucket: Bucket): void {
        (async () => {
            const requestId = uuidv4()
            const claim = await this.createClaim(bucket)
            await this.nodeToNode.send(bucket.getNodeId(), new ReceiptRequest({
                requestId,
                claim
            }))
            this.nodeToNode.registerErrorHandler(requestId, (errorResponse, source) => {
                logger.warn('receiver %s refused to provide receipt due to %s', source, errorResponse.errorCode)
                // TODO: cut connection?
            })
        })().catch((e) => {
            logger.warn('failed to send ReceiptRequest to %s, reason: %s', bucket.getNodeId(), e)
        })
    }

    private getCloseTime(bucket: Bucket): number {
        return Math.max(
            getWindowStartTime(bucket.getWindowNumber() + 1) + this.windowTimeoutMargin,
            bucket.getLastUpdate() + this.bucketUpdateTimeoutMargin
        )
    }

    private async createClaim(bucket: Bucket): Promise<Claim> {
        const [streamId, streamPartition] = StreamPartIDUtils.getStreamIDAndPartition(bucket.getStreamPartId())
        const claim: Omit<Claim, 'signature'> = {
            streamId,
            streamPartition,
            publisherId: bucket.getPublisherId(),
            msgChainId: bucket.getMsgChainId(),
            windowNumber: bucket.getWindowNumber(),
            messageCount: bucket.getMessageCount(),
            totalPayloadSize: bucket.getTotalPayloadSize(),
            receiver: bucket.getNodeId(),
            sender: this.myNodeId
        }
        return {
            ...claim,
            signature: await this.signers.claim.sign(claim)
        }
    }
}
