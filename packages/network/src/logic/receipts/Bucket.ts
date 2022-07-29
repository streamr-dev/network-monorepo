import { MessageID, StreamPartID } from 'streamr-client-protocol'
import { NodeId } from '../../identifiers'

export const WINDOW_LENGTH = 60 * 1000 // TODO: define production value

export function getWindowNumber(timestamp: number): number {
    return Math.floor(timestamp / WINDOW_LENGTH)
}

export function getWindowStartTime(windowNumber: number): number {
    return windowNumber * WINDOW_LENGTH
}

export type BucketID = string & { readonly __brand: 'BucketID' }

export function formBucketID({ nodeId, streamPartId, publisherId, msgChainId, windowNumber }: {
    nodeId: NodeId
    streamPartId: StreamPartID
    publisherId: string
    msgChainId: string
    windowNumber: number
}): BucketID {
    return `${nodeId}_${streamPartId}_${publisherId}_${msgChainId}_${windowNumber}` as BucketID
}

export function getBucketID(messageId: MessageID, nodeId: NodeId): BucketID {
    return formBucketID({
        nodeId,
        streamPartId: messageId.getStreamPartID(),
        publisherId: messageId.publisherId,
        msgChainId: messageId.msgChainId,
        windowNumber: getWindowNumber(messageId.timestamp)
    })
}

export class Bucket {
    private readonly id: BucketID
    private readonly nodeId: NodeId
    private readonly streamPartId: StreamPartID
    private readonly publisherId: string
    private readonly msgChainId: string
    private readonly windowNumber: number
    private messageCount = 0
    private totalPayloadSize = 0
    private lastUpdate = Date.now()

    constructor(messageId: MessageID, nodeId: NodeId) {
        this.id = getBucketID(messageId, nodeId)
        this.nodeId = nodeId
        this.streamPartId = messageId.getStreamPartID()
        this.publisherId = messageId.publisherId
        this.msgChainId = messageId.msgChainId
        this.windowNumber = getWindowNumber(messageId.timestamp)
    }

    record(payloadSize: number): void {
        this.messageCount += 1
        this.totalPayloadSize += payloadSize
        this.lastUpdate = Date.now()
    }

    getId(): BucketID {
        return this.id
    }

    getNodeId(): NodeId {
        return this.nodeId
    }

    getStreamPartId(): StreamPartID {
        return this.streamPartId
    }

    getPublisherId(): string {
        return this.publisherId
    }

    getMsgChainId(): string {
        return this.msgChainId
    }

    getWindowNumber(): number {
        return this.windowNumber
    }

    getMessageCount(): number {
        return this.messageCount
    }

    getTotalPayloadSize(): number {
        return this.totalPayloadSize
    }

    getLastUpdate(): number {
        return this.lastUpdate
    }
}
