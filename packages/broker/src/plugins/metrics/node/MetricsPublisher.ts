import { StreamOperation, StreamrClient } from 'streamr-client'
import { Logger } from 'streamr-network'
import { StorageNodeRecord } from 'streamr-network/dist/streamr-client-protocol'
import { PERIOD_LENGTHS, Sample } from './Sample'

export const STREAM_ID_SUFFIXES = {
    [PERIOD_LENGTHS.FIVE_SECONDS]: 'sec',
    [PERIOD_LENGTHS.ONE_MINUTE]: 'min',
    [PERIOD_LENGTHS.ONE_HOUR]: 'hour',
    [PERIOD_LENGTHS.ONE_DAY]: 'day'
}

export interface ClientOptions {
    ethereumPrivateKey: string,
    storageNode: string,
    storageNodes: StorageNodeRecord[]
    clientWsUrl?: string,
    clientHttpUrl?: string
}

const logger = new Logger(module)

export class MetricsPublisher {

    private readonly nodeAddress: string
    private readonly client: StreamrClient
    private readonly storageNodeAddress: string

    constructor(nodeAddress: string, clientOptions: ClientOptions) {
        this.nodeAddress = nodeAddress
        this.client = this.createClient(clientOptions)
        this.storageNodeAddress = clientOptions.storageNode
    }

    private createClient(options: {
        ethereumPrivateKey: string,
        storageNode: string,
        storageNodes: StorageNodeRecord[]
        clientWsUrl?: string,
        clientHttpUrl?: string
    }) {
        const storageNodeRecord = options.storageNodes.find((n) => n.address === options.storageNode)
        if (storageNodeRecord === undefined) {
            throw new Error(`Value ${storageNodeRecord} not present in config.storageNodeRegistry`)
        }
        return new StreamrClient({
            auth: {
                privateKey: options.ethereumPrivateKey,
            },
            url: options.clientWsUrl,
            restUrl: options.clientHttpUrl,
            storageNode: storageNodeRecord
        })
    }

    async publish(sample: Sample): Promise<void> {
        const periodLength = sample.period.end - sample.period.start
        const streamId = this.getStreamId(periodLength)
        try {
            await this.client.publish(streamId, sample)
        } catch (e: any) {
            logger.warn(`Unable to publish NodeMetrics: ${e.message}`)
        }
    }

    async ensureStreamsCreated() {
        await Promise.all(Object.keys(STREAM_ID_SUFFIXES).map((periodLengthAsString: string) => this.ensureStreamCreated(Number(periodLengthAsString))))
    }

    // TODO simplify error handling?
    private async ensureStreamCreated(periodLength: number): Promise<string> {
        const stream = await this.client.getOrCreateStream({
            id: this.getStreamId(periodLength)
        })
        await stream.grantPermission('stream_get' as StreamOperation, undefined)
        await stream.grantPermission('stream_subscribe' as StreamOperation, undefined)
        if (periodLength !== PERIOD_LENGTHS.FIVE_SECONDS) {
            // TODO: pretify this error handler
            // https://linear.app/streamr/issue/BACK-155/assign-a-stream-to-a-storage-node-when-it-has-already-been-assigned
            try {
                await stream.addToStorageNode(this.storageNodeAddress)
            } catch (e: any) {
                if (!e.body) { throw e }
                let parsedBody
                try {
                    parsedBody = JSON.parse(e.body)
                } catch (jsonError) {
                    throw e // original error, not parsing one
                }
                // expected error when re-adding storage node
                if (parsedBody.code !== 'DUPLICATE_NOT_ALLOWED') {
                    throw e
                }
            }
        }
        return stream.id
    }

    /**
     * Fetch the sample from the previous Broker session.
     *
     * E.g. if Broker was running at 01:23:00-03:45:59, it generated
     * - 'hour' reports of 01 and 02
     * - 'min' reports for 01:23-03:44
     * - many 'sec' reports
     *
     * We'll fetch all 'hour' reports, and all 'min' reports which have not yet been
     * aggerated to 'hour' reports. All 'sec' reports are ignored.
     *
     * With this data we are able to generate the correct 'day' report at midnight
     * as it will include the 'hour' data for both this run and the previous run.
     * The aggregator will also generate the missing 'hour' report from the 'min' samples.
     *
     * This same logic applies also if the previous Broker run was before the current date.
     * In that case the missing 'hour' and 'day' reports are  aggregated and published,
     * but they don't affect to the current 'day' sample.
     */
    async fetchExistingSamples(): Promise<{ minutes: Sample[], hours: Sample[] }> {
        try {
            const MAX_HOUR_COUNT = 24
            const MAX_MINUTE_COUNT = 60
            const days: Sample[] = await this.getHistoricalSamples(PERIOD_LENGTHS.ONE_DAY, 1)
            const hours: Sample[] = await this.getHistoricalSamples(PERIOD_LENGTHS.ONE_HOUR, MAX_HOUR_COUNT)
            const minutes: Sample[] = await this.getHistoricalSamples(PERIOD_LENGTHS.ONE_MINUTE, MAX_MINUTE_COUNT)
            const getLatestTimestamp = (historicalSamples: Sample[]) => {
                if (historicalSamples.length > 0) {
                    const lastItem = historicalSamples[historicalSamples.length - 1]
                    return lastItem.period.end
                } else {
                    return undefined
                }
            }
            const getNonAggregatedSamples = (samples: Sample[], latestParentTimestamp?: number) => {
                if (latestParentTimestamp !== undefined) {
                    return samples.filter((sample) => sample.period.end > latestParentTimestamp)
                } else {
                    return samples
                }
            }
            return {
                minutes: getNonAggregatedSamples(minutes, getLatestTimestamp(hours)),
                hours: getNonAggregatedSamples(hours, getLatestTimestamp(days))
            }
        } catch (e) {
            logger.warn('Unable to fetch initial data for NodeMetrics')
            return {
                minutes: [],
                hours: []
            }
        }
    }

    // TODO simplify error handling?
    private async getHistoricalSamples(
        periodLength: number,
        last: number,
        timeout = 10 * 1000
    ): Promise<Sample[]> {
        return new Promise((resolve, reject) => {
            const startTimeout = () => {
                return setTimeout(() => {
                    reject(new Error('StreamMetrics timed out'))
                }, timeout)
            }
            let timeoutId = startTimeout()
            const messages: Sample[] = []
            return this.client.resend(
                {
                    stream: this.getStreamId(periodLength),
                    resend: {
                        last
                    }
                },
                (message) => {
                    messages.push(message)
                    clearTimeout(timeoutId)
                    timeoutId = startTimeout()
                }
            )
                .then((subscription) => {
                    // @ts-ignore subscription type does not property inherit EventEmitter in client codebase
                    subscription.once('resent', () => {
                        // currently there can be previous data from the previous PerNodeMetrics implementation,
                        // -> filter those out 
                        // TODO remove this filter soon
                        resolve(messages.filter((m) => m.period !== undefined && m.period.start !== undefined && m.period.end !== undefined))
                    })
                    // @ts-ignore subscription type does not property inherit EventEmitter in client codebase
                    subscription.once('no_resend', () => {
                        resolve(messages)
                    })
                })
                .catch(reject)
        })
    }

    getStreamId(periodLength: number) {
        const suffix = STREAM_ID_SUFFIXES[periodLength]
        if (suffix !== undefined) {
            return `${this.nodeAddress.toLowerCase()}/streamr/node/metrics/${suffix}`
        } else {
            throw new Error(`Invalid period length: ${periodLength}`)
        }
    }

    async stop() {
        await this.client.ensureDisconnected()
    }
}
