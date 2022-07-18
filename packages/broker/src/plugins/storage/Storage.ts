import { auth, Client, types, tracker } from 'cassandra-driver'
import { MetricsContext, RateMetric } from 'streamr-network'
import { BatchManager } from './BatchManager'
import { Readable, Transform } from 'stream'
import { EventEmitter } from 'events'
import { pipeline } from 'stream'
import { v1 as uuidv1 } from 'uuid'
import merge2 from 'merge2'
import { StreamMessage } from 'streamr-client-protocol'
import { BucketManager, BucketManagerOptions } from './BucketManager'
import { Logger } from '@streamr/utils'
import { Bucket, BucketId } from './Bucket'
import { MAX_SEQUENCE_NUMBER_VALUE, MIN_SEQUENCE_NUMBER_VALUE } from './DataQueryEndpoints'

const logger = new Logger(module)

const MAX_TIMESTAMP_VALUE = 8640000000000000 // https://262.ecma-international.org/5.1/#sec-15.9.1.1
const MAX_RESEND_LAST = 10000

export interface StartCassandraOptions {
    contactPoints: string[]
    localDataCenter: string
    keyspace: string
    username?: string
    password?: string
    opts?: Partial<BucketManagerOptions & { useTtl: boolean }>
}

export type MessageFilter = (streamMessage: StreamMessage) => boolean

const bucketsToIds = (buckets: Bucket[]) => buckets.map((bucket: Bucket) => bucket.getId())

// NET-329
interface ResendDebugInfo {
    streamId: string
    partition?: number
    limit?: number
    fromTimestamp?: number
    toTimestamp?: number
    fromSequenceNo?: number | null
    toSequenceNo?: number | null
    publisherId?: string | null
    msgChainId?: string | null
}

export type StorageOptions = Partial<BucketManagerOptions> & {
    useTtl?: boolean
    retriesIntervalMilliseconds?: number
}

export class Storage extends EventEmitter {

    opts: StorageOptions
    cassandraClient: Client
    bucketManager: BucketManager
    batchManager: BatchManager
    pendingStores: Map<string, NodeJS.Timeout>

    constructor(cassandraClient: Client, opts: StorageOptions) {
        super()

        const defaultOptions = {
            useTtl: false,
            retriesIntervalMilliseconds: 500
        }

        this.opts = {
            ...defaultOptions,
            ...opts
        }

        this.cassandraClient = cassandraClient
        this.bucketManager = new BucketManager(cassandraClient, opts)
        this.batchManager = new BatchManager(cassandraClient, {
            useTtl: this.opts.useTtl
        })
        this.pendingStores = new Map()
    }

    async store(streamMessage: StreamMessage): Promise<boolean> {
        logger.debug('Store message')

        const bucketId = this.bucketManager.getBucketId(streamMessage.getStreamId(), streamMessage.getStreamPartition(), streamMessage.getTimestamp())

        return new Promise((resolve, reject) => {
            if (bucketId) {
                logger.trace(`found bucketId: ${bucketId}`)

                this.bucketManager.incrementBucket(bucketId, Buffer.byteLength(streamMessage.serialize()))
                setImmediate(() => this.batchManager.store(bucketId, streamMessage, (err?: Error) => {
                    if (err) {
                        reject(err)
                    } else {
                        this.emit('write', streamMessage)
                        resolve(true)
                    }
                }))
            } else {
                const messageId = streamMessage.messageId.serialize()
                logger.trace(`bucket not found, put ${messageId} to pendingMessages`)

                const uuid = uuidv1()
                const timeout = setTimeout(() => {
                    this.pendingStores.delete(uuid)
                    // eslint-disable-next-line promise/catch-or-return
                    this.store(streamMessage).then(resolve, reject)
                }, this.opts.retriesIntervalMilliseconds!)
                this.pendingStores.set(uuid, timeout)
            }
        })
    }

    requestLast(streamId: string, partition: number, limit: number): Readable {
        if (limit > MAX_RESEND_LAST) {
            // eslint-disable-next-line no-param-reassign
            limit = MAX_RESEND_LAST
        }

        logger.trace('requestLast %o', { streamId, partition, limit })

        const GET_LAST_N_MESSAGES = 'SELECT payload FROM stream_data WHERE '
            + 'stream_id = ? AND partition = ? AND bucket_id IN ? '
            + 'ORDER BY ts DESC, sequence_no DESC '
            + 'LIMIT ?'
        const COUNT_MESSAGES = 'SELECT COUNT(*) AS total FROM stream_data WHERE stream_id = ? AND partition = ? AND bucket_id = ?'
        const GET_BUCKETS = 'SELECT id FROM bucket WHERE stream_id = ? AND partition = ?'

        let total = 0
        const options = {
            prepare: true, fetchSize: 1
        }

        const resultStream = this.createResultStream({ streamId, partition, limit })

        const makeLastQuery = async (bucketIds: BucketId[]) => {
            try {
                const params = [streamId, partition, bucketIds, limit]
                const resultSet = await this.cassandraClient.execute(GET_LAST_N_MESSAGES, params, {
                    prepare: true,
                    fetchSize: 0 // disable paging
                })
                resultSet.rows.reverse().forEach((r: types.Row) => {
                    resultStream.write(r)
                })
                resultStream.end()
            } catch (err) {
                resultStream.destroy(err)
            }
        }

        let bucketId: BucketId
        const bucketIds: BucketId[] = []
        /**
         * Process:
         * - get latest bucketId => count number of messages in this bucket
         * - if enough => get all messages and return
         * - if not => move to the next bucket and repeat cycle
         */
        this.cassandraClient.eachRow(GET_BUCKETS, [streamId, partition], options, (_n, row: types.Row) => {
            bucketId = row.id
            bucketIds.push(bucketId)
        }, async (err: Error | undefined, result: types.ResultSet) => {
            // do nothing if resultStream ended
            if (resultStream.writableEnded || resultStream.readableEnded) { return }
            if (err) {
                resultStream.destroy(err)
            } else {
                // no buckets found at all
                if (!bucketId) {
                    resultStream.end()
                    return
                }
                try {
                    // get total stored message in bucket
                    const resultSet = await this.cassandraClient.execute(COUNT_MESSAGES, [streamId, partition, bucketId], {
                        prepare: true,
                        fetchSize: 0 // disable paging
                    })
                    const row = resultSet.first()
                    total += row.total.low

                    // if not enough messages and we next page exists, repeat eachRow
                    if (result.nextPage && total < limit && total < MAX_RESEND_LAST) {
                        result.nextPage()
                    } else {
                        makeLastQuery(bucketIds)
                    }
                } catch (err) {
                    resultStream.destroy(err)
                }
            }
        })

        return resultStream
    }

    requestFrom(streamId: string, partition: number, fromTimestamp: number, fromSequenceNo: number, publisherId?: string): Readable {
        logger.trace('requestFrom %o', { streamId, partition, fromTimestamp, fromSequenceNo, publisherId })

        return this.fetchRange(
            streamId,
            partition,
            fromTimestamp,
            fromSequenceNo,
            MAX_TIMESTAMP_VALUE,
            MAX_SEQUENCE_NUMBER_VALUE,
            publisherId
        )
    }

    requestRange(
        streamId: string,
        partition: number,
        fromTimestamp: number,
        fromSequenceNo: number,
        toTimestamp: number,
        toSequenceNo: number,
        publisherId: string | undefined,
        msgChainId: string | undefined
    ): Readable {
        logger.trace('requestRange %o', { streamId, partition, fromTimestamp, fromSequenceNo, toTimestamp, toSequenceNo, publisherId, msgChainId })

        // TODO is there any reason why we shouldn't allow range queries which contain publisherId, but not msgChainId?
        // (or maybe even queries with msgChain but without publisherId)
        const isValidRequest = (publisherId !== undefined && msgChainId !== undefined) || (publisherId === undefined && msgChainId === undefined)
        if (!isValidRequest) {
            throw new Error('Invalid combination of requestFrom arguments')
        }
        return this.fetchRange(streamId, partition, fromTimestamp,
            fromSequenceNo, toTimestamp, toSequenceNo, publisherId, msgChainId)
    }

    enableMetrics(metricsContext: MetricsContext): void {
        const metrics = {
            readMessagesPerSecond: new RateMetric(),
            readBytesPerSecond: new RateMetric(),
            writeMessagesPerSecond: new RateMetric(),
            writeBytesPerSecond: new RateMetric()
        }
        metricsContext.addMetrics('broker.plugin.storage', metrics)
        this.on('read', (streamMessage: StreamMessage) => {
            metrics.readMessagesPerSecond.record(1)
            metrics.readBytesPerSecond.record(streamMessage.getContent(false).length)
        })
        this.on('write', (streamMessage: StreamMessage) => {
            metrics.writeMessagesPerSecond.record(1)
            metrics.writeBytesPerSecond.record(streamMessage.getContent(false).length)
        })
    }

    close(): Promise<void> {
        const keys = [...this.pendingStores.keys()]
        keys.forEach((key) => {
            const timeout = this.pendingStores.get(key)
            clearTimeout(timeout!)
            this.pendingStores.delete(key)
        })

        this.bucketManager.stop()
        this.batchManager.stop()
        return this.cassandraClient.shutdown()
    }

    private fetchRange(
        streamId: string,
        partition: number,
        fromTimestamp: number,
        fromSequenceNo: number,
        toTimestamp: number,
        toSequenceNo: number,
        publisherId?: string,
        msgChainId?: string
    ) {
        const resultStream = this.createResultStream({
            streamId,
            partition,
            fromTimestamp,
            fromSequenceNo,
            toTimestamp,
            toSequenceNo,
            publisherId,
            msgChainId,
        })

        this.bucketManager.getBucketsByTimestamp(streamId, partition, fromTimestamp, toTimestamp).then((buckets: Bucket[]) => {
            if (buckets.length === 0) {
                resultStream.end()
                return
            }

            const bucketIds = bucketsToIds(buckets)

            let queries
            // optimize the typical case where the sequenceNumber doesn't filter out anything
            if ((fromSequenceNo === MIN_SEQUENCE_NUMBER_VALUE) && (toSequenceNo === MAX_SEQUENCE_NUMBER_VALUE)) {
                queries = [
                    {
                        where: 'WHERE stream_id = ? AND partition = ? AND bucket_id IN ? AND ts >= ? AND ts <= ?',
                        params: [streamId, partition, bucketIds, fromTimestamp, toTimestamp]
                    }
                ]
            } else {
                queries = [
                    {
                        where: 'WHERE stream_id = ? AND partition = ? AND bucket_id IN ? AND ts = ? AND sequence_no >= ?',
                        params: [streamId, partition, bucketIds, fromTimestamp, fromSequenceNo]
                    },
                    {
                        where: 'WHERE stream_id = ? AND partition = ? AND bucket_id IN ? AND ts > ? AND ts < ?',
                        params: [streamId, partition, bucketIds, fromTimestamp, toTimestamp]
                    },
                    {
                        where: 'WHERE stream_id = ? AND partition = ? AND bucket_id IN ? AND ts = ? AND sequence_no <= ?',
                        params: [streamId, partition, bucketIds, toTimestamp, toSequenceNo]
                    }
                ]
            }

            queries.forEach((q) => {
                if (publisherId !== undefined) {
                    q.where += ' AND publisher_id = ?'
                    q.params.push(publisherId)
                }
                if (msgChainId !== undefined) {
                    q.where += ' AND msg_chain_id = ?'
                    q.params.push(msgChainId)
                }
            })

            const streams = queries.map((q) => {
                const select = `SELECT payload FROM stream_data ${q.where} ALLOW FILTERING`
                return this.queryWithStreamingResults(select, q.params)
            })

            return pipeline(
                merge2(...streams, {
                    // @ts-expect-error options not in type
                    pipeError: true,
                }),
                resultStream,
                (err: Error | null) => {
                    if (err) {
                        resultStream.destroy(err)
                        streams.forEach((s) => s.destroy(undefined))
                    }
                }
            )
        })
            .catch((e) => {
                resultStream.destroy(e)
            })

        return resultStream
    }

    private queryWithStreamingResults(query: string, queryParams: any[]) {
        return this.cassandraClient.stream(query, queryParams, {
            prepare: true,
            // force small page sizes, otherwise gives RangeError [ERR_OUT_OF_RANGE]: The value of "offset" is out of range.
            fetchSize: 128,
            readTimeout: 0,
        }) as Readable
    }

    private parseRow(row: types.Row, debugInfo: ResendDebugInfo): StreamMessage | null {
        if (row.payload === null) {
            logger.error(`Found message with NULL payload on cassandra; debug info: ${JSON.stringify(debugInfo)}`)
            return null
        }

        const streamMessage = StreamMessage.deserialize(row.payload.toString())
        this.emit('read', streamMessage)
        return streamMessage
    }

    private createResultStream(debugInfo: ResendDebugInfo) {
        const self = this // eslint-disable-line @typescript-eslint/no-this-alias
        let last = Date.now()
        return new Transform({
            highWaterMark: 1024, // buffer up to 1024 messages
            objectMode: true,
            transform(row: types.Row, _, done) {
                const now = Date.now()
                const message = self.parseRow(row, debugInfo)
                if (message !== null) {
                    this.push(message)
                }
                // To avoid blocking main thread for too long, after every 100ms
                // pause & resume the cassandraStream to give other events in the event
                // queue a chance to be handled.
                if ((now - last) > 100) {
                    setImmediate(() => {
                        last = Date.now()
                        done()
                    })
                } else {
                    done()
                }
            }
        })
    }

    async getFirstMessageTimestampInStream(streamId: string, partition: number): Promise<number> {
        const bucketQuery = 'SELECT id FROM bucket WHERE stream_id=? AND partition =? ORDER BY date_create ASC LIMIT 1'

        const queryParams = [streamId, partition]

        const buckets = await this.cassandraClient.execute(bucketQuery, queryParams, {
            prepare: true,
        })

        if (buckets.rows.length !== 1) {
            return 0
        }

        const bucketId = buckets.rows[0].id

        const query = 'SELECT ts FROM stream_data WHERE stream_id=? AND partition=? AND bucket_id=? ORDER BY ts ASC LIMIT 1'

        const streams = await this.cassandraClient.execute(query, [
            streamId,
            partition,
            bucketId
        ], {
            prepare: true
        })

        if (streams.rows.length !== 1) {
            return 0
        }

        const { ts } = streams.rows[0]

        return new Date(ts).getTime()
    }

    async getLastMessageTimestampInStream(streamId: string, partition: number): Promise<number> {
        const bucketQuery = 'SELECT id FROM bucket WHERE stream_id=? AND partition =? ORDER BY date_create DESC LIMIT 1'

        const queryParams = [streamId, partition]

        const buckets = await this.cassandraClient.execute(bucketQuery, queryParams, {
            prepare: true,
        })

        if (buckets.rows.length !== 1) {
            return 0
        }

        const bucketId = buckets.rows[0].id

        const query = 'SELECT ts FROM stream_data WHERE stream_id=? AND partition=? AND bucket_id=? ORDER BY ts DESC LIMIT 1'

        const streams = await this.cassandraClient.execute(query, [
            streamId,
            partition,
            bucketId
        ], {
            prepare: true
        })

        if (streams.rows.length !== 1) {
            return 0
        }

        const { ts } = streams.rows[0]

        return new Date(ts).getTime()
    }

    async getNumberOfMessagesInStream(streamId: string, partition: number): Promise<number> {
        const query = 'SELECT SUM(records) as count FROM bucket WHERE stream_id=? AND partition=?'
        const queryParams = [
            streamId,
            partition
        ]

        const res = await this.cassandraClient.execute(query, queryParams, {
            prepare: true
        })

        if (res.rows.length !== 1) {
            return 0
        }

        const { count } = res.rows[0]

        return count
    }

    async getTotalBytesInStream(streamId: string, partition: number): Promise<number> {
        const query = 'SELECT SUM(size) as count FROM bucket WHERE stream_id=? AND partition=?'
        const queryParams = [
            streamId,
            partition
        ]
        const res = await this.cassandraClient.execute(query, queryParams, {
            prepare: true
        })

        if (res.rows.length !== 1) {
            return 0
        }

        let { count } = res.rows[0]

        // Cassandra's integer has overflown, calculate fetching row by row
        if (count < 0) {
            count = 0

            const query = 'SELECT size FROM bucket WHERE stream_id=? AND partition=?'
            const queryParams = [
                streamId,
                partition
            ]

            const res = await this.cassandraClient.execute(query, queryParams, {
                prepare: true
            })

            for (const row of res.rows) {
                count += row.size
            }
        }

        return count
    }

}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(() => resolve(undefined), ms))
}

export const startCassandraStorage = async ({
    contactPoints,
    localDataCenter,
    keyspace,
    username,
    password,
    opts
}: StartCassandraOptions): Promise<Storage> => {
    const authProvider = new auth.PlainTextAuthProvider(username || '', password || '')
    const requestLogger = new tracker.RequestLogger({
        slowThreshold: 10 * 1000, // 10 secs
    })
    // @ts-expect-error 'emitter' field is missing in type definition file
    requestLogger.emitter.on('slow', (message: Todo) => logger.warn(message))
    const cassandraClient = new Client({
        contactPoints,
        localDataCenter,
        keyspace,
        authProvider,
        requestTracker: requestLogger,
        pooling: {
            maxRequestsPerConnection: 32768
        }
    })
    const nbTrials = 20
    let retryCount = nbTrials
    let lastError = ''
    while (retryCount > 0) {
        /* eslint-disable no-await-in-loop */
        try {
            await cassandraClient.connect().catch((err) => { throw err })
            return new Storage(cassandraClient, opts || {})
        } catch (err) {
            // eslint-disable-next-line no-console
            console.log('Cassandra not responding yet...')
            retryCount -= 1
            await sleep(5000)
            lastError = err
        }
        /* eslint-enable no-await-in-loop */
    }
    throw new Error(`Failed to connect to Cassandra after ${nbTrials} trials: ${lastError.toString()}`)
}
