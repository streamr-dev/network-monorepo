import { keyToArrayIndex } from './HashUtil'
import { initContract, SmartContractConfig } from './SmartContractUtil'

import * as trackerRegistryConfig from '../../contracts/TrackerRegistry.json'

export type TrackerRecord = {
    id: string
    http: string
    ws: string
}

export class TrackerRegistry {
    private readonly records: TrackerRecord[]

    constructor(records: TrackerRecord[]) {
        this.records = records
        this.records.sort()  // TODO does this actually sort anything?
    }

    getTracker(streamId: string, partition = 0): TrackerRecord {
        if (typeof streamId !== 'string' || streamId.indexOf('::') >= 0) {
            throw new Error(`invalid id: ${streamId}`)
        }
        if (!Number.isInteger(partition) || partition < 0) {
            throw new Error(`invalid partition: ${partition}`)
        }

        const streamKey = `${streamId}::${partition}`

        const index = keyToArrayIndex(this.records.length, streamKey)
        return this.records[index]
    }

    getAllTrackers(): TrackerRecord[] {
        return this.records
    }
}

async function fetchTrackers(config: SmartContractConfig) {
    const contract = await initContract(config, trackerRegistryConfig.abi)
    if (typeof contract.getNodes !== 'function') {
        throw Error(`getNodes function is not defined in smart contract (${config.contractAddress})`)
    }

    return await contract.getNodes()
}

export function createTrackerRegistry(servers: TrackerRecord[]): TrackerRegistry {
    return new TrackerRegistry(servers)
}

export async function getTrackerRegistryFromContract(config: SmartContractConfig): Promise<TrackerRegistry> {
    const trackers = await fetchTrackers(config)
    const records: TrackerRecord[] = []
    for (let i = 0; i < trackers.length; ++i) {
        const { metadata, url, nodeAddress } = trackers[i]
        try {
            // The field is tracker.metadata in newer contracts and tracker.url in old contracts.
            // It's safe to clean up tracker.url when no such contract is used anymore.
            const urls = JSON.parse(metadata || url)
            records.push({
                id: nodeAddress,
                ...urls
            })
        } catch (e) {
            throw new Error(`Element trackers[${i}] not parsable as object: ${trackers[i]}`)
        }
    }
    return createTrackerRegistry(records)
}
