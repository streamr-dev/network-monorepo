import * as storageNodeRegistryConfig from '../../contracts/NodeRegistry.json'
import { initContract, SmartContractConfig } from './SmartContractUtil'

// storageNodeAddress => HTTP address
export type StorageNodeRecord = {
    address: string
    url: string
}

export class StorageNodeRegistry {
    private readonly records: StorageNodeRecord[]

    constructor(records: StorageNodeRecord[]) {
        this.records = records
    }

    getStorageNodeHTTP(address: string): string | never {
        const found = this.records.find((p) => p.address === address)
        if (found) {
            return found.url
        } else {
            throw new Error(`Storage node with address (${address}) not found in registry`)
        }
    }

    getAllStorageNodes(): StorageNodeRecord[] {
        return this.records
    }
}
async function fetchStorageNodes(config: SmartContractConfig): Promise<StorageNodeRecord[]> {
    const contract = await initContract(config, storageNodeRegistryConfig.abi)
    if (typeof contract.getNodes !== 'function') {
        throw Error(`getNodes function is not defined in smart contract (${config.contractAddress})`)
    }

    const result = await contract.getNodes()
    return result.map((node: any) => {
        return {
            address: node.nodeAddress,
            url: JSON.parse(node.metadata).http
        }
    })
}

export function createStorageNodeRegistry(servers: StorageNodeRecord[]): StorageNodeRegistry {
    return new StorageNodeRegistry(servers)
}

export async function getStorageNodeRegistryFromContract(config: SmartContractConfig): Promise<StorageNodeRegistry> {
    const storageNodes = await fetchStorageNodes(config)
    return createStorageNodeRegistry(storageNodes)
}
