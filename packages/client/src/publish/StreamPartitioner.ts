/**
 * Derive partitions for StreamMessages.
 */
import { StreamID, Utils } from 'streamr-client-protocol'
import { CacheFn } from '../utils/caches'
import { ConfigInjectionToken, CacheConfig } from '../Config'
import { inject, Lifecycle, scoped } from 'tsyringe'
import { StreamRegistryCached } from '../registry/StreamRegistryCached'

export type PartitionKey = string | number | undefined

@scoped(Lifecycle.ContainerScoped)
export class StreamPartitioner {  // TODO remove this class
    constructor(
        private streamRegistryCached: StreamRegistryCached,
        @inject(ConfigInjectionToken.Cache) private cacheOptions: CacheConfig,
    ) {
        // NOTE: ensure cache partitions by streamId + partitionCount.
        // i.e. don't cache on just partitionCount + key
        // otherwise streams with same partition count will all map
        // to the same partition
    }

    public async compute(streamId: StreamID, partitionKey: PartitionKey): Promise<number> {
        // no need to fetch stream partition info if partition key is 0
        // partition 0 should always exist
        if (partitionKey === 0) {
            return 0
        }

        const stream = await this.streamRegistryCached.getStream(streamId)
        return this.computeStreamPartition(stream.id, stream.partitions, partitionKey)
    }

    protected computeStreamPartition = CacheFn((_streamId: StreamID, partitionCount: number, partitionKey: PartitionKey) => {
        if (!(Number.isSafeInteger(partitionCount) && partitionCount > 0)) {
            throw new Error(`partitionCount is not a safe positive integer! ${partitionCount}`)
        }

        if (partitionKey == null) {
            // Fallback to random partition if no key
            return Math.floor(Math.random() * partitionCount)
        }

        return Utils.keyToArrayIndex(partitionCount, partitionKey)
    }, {
        ...this.cacheOptions,
        cacheKey([streamId, partitionCount, partitionKey]) {
            return `${streamId}-${partitionCount}-${partitionKey}`
        }
    })
}
