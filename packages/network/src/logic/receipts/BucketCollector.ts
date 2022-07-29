import { StreamMessage } from 'streamr-client-protocol'
import { NodeId } from '../../composition'
import { Bucket, BucketID, getBucketID } from './Bucket'

export class BucketCollector {
    private readonly buckets = new Map<BucketID, Bucket>()
    private readonly onCreateOrUpdate?: (bucket: Bucket) => void

    constructor(onCreateOrUpdate?: (bucket: Bucket) => void) {
        this.onCreateOrUpdate = onCreateOrUpdate
    }

    record(message: StreamMessage, nodeId: NodeId): void {
        const bucketId = getBucketID(message.messageId, nodeId)
        if (!this.buckets.has(bucketId)) {
            this.buckets.set(bucketId, new Bucket(message.messageId, nodeId))
        }
        const bucket = this.buckets.get(bucketId)!
        bucket.record(message.getSerializedContent().length)
        this.onCreateOrUpdate?.(bucket)
    }

    getBucket(bucketId: BucketID): Bucket | undefined {
        return this.buckets.get(bucketId)
    }

    removeBucket(bucketId: BucketID): void {
        this.buckets.delete(bucketId)
    }
}
