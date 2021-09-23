import { SmartContractConfig, TrackerRecord, StorageNodeRecord } from 'streamr-network/dist/streamr-client-protocol'

export interface TurnConfig {
    url: string,
    username: string,
    password: string
}

export interface NetworkConfig {
    name: string,
    trackers: TrackerRecord[] | SmartContractConfig,
    stun: string | null,
    turn: TurnConfig | null
    location: {
        latitude: number,
        longitude: number,
        country: string,
        city: string
    } | null
}

export interface HttpServerConfig {
    port: number,
    privateKeyFileName: string | null,
    certFileName: string | null
}

export interface StorageNodeConfig {
    registry: StorageNodeRecord[] | SmartContractConfig
}

export interface Config {
    ethereumPrivateKey: string
    generateSessionId: boolean
    network: NetworkConfig,
    streamrUrl: string,
    streamrAddress: string,
    storageNodeConfig: StorageNodeConfig,
    httpServer: HttpServerConfig
    plugins: Record<string,any>
    apiAuthentication: {
        keys: string[]
    } | null
}
