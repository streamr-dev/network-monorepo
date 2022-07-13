import 'reflect-metadata'
import type { BigNumber } from '@ethersproject/bignumber'
import cloneDeep from 'lodash/cloneDeep'
import Ajv, { ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import merge from 'lodash/merge'

import type { AuthConfig } from './Authentication'
import type { EthereumConfig } from './Ethereum'
import type { EncryptionConfig } from './encryption/KeyExchangeStream'

import CONFIG_SCHEMA from './config.schema.json'
import { EthereumAddress, SmartContractRecord } from 'streamr-client-protocol'

import type { NetworkNodeOptions } from 'streamr-network'
import type { InspectOptions } from 'util'
import type { ConnectionInfo } from '@ethersproject/web'

export type CacheConfig = {
    maxSize: number,
    maxAge: number
}

export type TimeoutsConfig = {
    theGraph: {
        timeout: number
        retryInterval: number
    }
    storageNode: {
        timeout: number
        retryInterval: number
    }
    jsonRpc: {
        timeout: number
        retryInterval: number
    },
    /** @internal */
    encryptionKeyRequest?: number
    httpFetchTimeout: number
}

export type SubscribeConfig = {
    /** Attempt to order messages */
    orderMessages: boolean
    gapFill: boolean
    maxGapRequests: number
    retryResendAfter: number
    gapFillTimeout: number
}

export type ConnectionConfig = {
    /** Some TheGraph instance, that indexes the streamr registries */
    theGraphUrl: string
}

export type TrackerRegistrySmartContract = { jsonRpcProvider?: ConnectionInfo, contractAddress: EthereumAddress }

export type NetworkConfig = Omit<NetworkNodeOptions, 'trackers' | 'metricsContext'> & {
    trackers: SmartContractRecord[] | TrackerRegistrySmartContract
}

export type DebugConfig = {
    inspectOpts: InspectOptions
}

export interface MetricsPeriodConfig {
    streamId: string
    duration: number
}

export type MetricsConfig = {
    periods: MetricsPeriodConfig[]
} | boolean

/**
 * @category Important
 */
export type StrictStreamrClientConfig = {
    /** Custom human-readable debug id for client. Used in logging. Unique id will be generated regardless. */
    id?: string,
    /**
    * Authentication: identity used by this StreamrClient instance.
    * Can contain member privateKey or (window.)ethereum
    */
    auth: AuthConfig
    network: NetworkConfig
    cache: CacheConfig,
    /** @internal */
    _timeouts: TimeoutsConfig
    /** @internal */
    debug: DebugConfig
    metrics: MetricsConfig
} & (
    EthereumConfig
    & ConnectionConfig
    & SubscribeConfig
    & EncryptionConfig
)

export type StreamrClientConfig = Partial<Omit<StrictStreamrClientConfig, 'network' | 'debug'> & {
    network: Partial<StrictStreamrClientConfig['network']>
    /** @internal */
    debug: Partial<StrictStreamrClientConfig['debug']>
}>

export const STREAMR_STORAGE_NODE_GERMANY = '0x31546eEA76F2B2b3C5cC06B1c93601dc35c9D916'

/**
 * @category Important
 */
export const STREAM_CLIENT_DEFAULTS: StrictStreamrClientConfig = {
    auth: {},

    // Streamr Core options
    theGraphUrl: 'https://api.thegraph.com/subgraphs/name/streamr-dev/streams',
    // storageNodeAddressDev = new StorageNode('0xde1112f631486CfC759A50196853011528bC5FA0', '')

    // P2P Streamr Network options
    orderMessages: true,
    retryResendAfter: 5000,
    gapFillTimeout: 5000,
    gapFill: true,
    maxGapRequests: 5,

    // Encryption options
    encryptionKeys: {},

    // Ethereum related options
    // For ethers.js provider params, see https://docs.ethers.io/ethers.js/v5-beta/api-providers.html#provider
    mainChainRPCs: undefined, // Default to ethers.js default provider settings
    streamRegistryChainRPCs: {
        name: 'polygon',
        chainId: 137,
        rpcs: [{
            url: 'https://polygon-rpc.com',
            timeout: 120 * 1000
        }, {
            url: 'https://poly-rpc.gateway.pokt.network/',
            timeout: 120 * 1000
        }, {
            url: 'https://rpc-mainnet.matic.network',
            timeout: 120 * 1000
        }]
    },
    streamRegistryChainAddress: '0x0D483E10612F327FC11965Fc82E90dC19b141641',
    streamStorageRegistryChainAddress: '0xe8e2660CeDf2a59C917a5ED05B72df4146b58399',
    storageNodeRegistryChainAddress: '0x080F34fec2bc33928999Ea9e39ADc798bEF3E0d6',
    ensCacheChainAddress: '0x870528c1aDe8f5eB4676AA2d15FC0B034E276A1A',
    network: {
        trackers: {
            contractAddress: '0xab9BEb0e8B106078c953CcAB4D6bF9142BeF854d'
        },
        acceptProxyConnections: false
    },
    ethereumNetworks: {
        polygon: {
            chainId: 137,
            gasPriceStrategy: (estimatedGasPrice: BigNumber) => estimatedGasPrice.add('10000000000'),
        }
    },
    cache: {
        maxSize: 10000,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
    _timeouts: {
        theGraph: {
            timeout: 60 * 1000,
            retryInterval: 1000
        },
        storageNode: {
            timeout: 30 * 1000,
            retryInterval: 1000
        },
        jsonRpc: {
            timeout: 30 * 1000,
            retryInterval: 1000
        },
        httpFetchTimeout: 30 * 1000
    },
    debug: {
        inspectOpts: {
            depth: 5,
            maxStringLength: 512
        }
    },
    metrics: {
        periods: [
            {
                duration: 5000,
                streamId: 'streamr.eth/metrics/nodes/firehose/sec'
            },
            {
                duration: 60000,
                streamId: 'streamr.eth/metrics/nodes/firehose/min'
            },
            {
                duration: 3600000,
                streamId: 'streamr.eth/metrics/nodes/firehose/hour'
            },
            {
                duration: 86400000,
                streamId: 'streamr.eth/metrics/nodes/firehose/day'
            }
        ]
    }
}

export const createStrictConfig = (inputOptions: StreamrClientConfig = {}): StrictStreamrClientConfig => {
    validateConfig(inputOptions)
    const opts = cloneDeep(inputOptions)
    const defaults = cloneDeep(STREAM_CLIENT_DEFAULTS)

    const options: StrictStreamrClientConfig = {
        ...defaults,
        ...opts,
        network: {
            ...merge(defaults.network || {}, opts.network),
            trackers: opts.network?.trackers ?? defaults.network.trackers,
        },
        debug: merge(defaults.debug || {}, opts.debug),
        cache: {
            ...defaults.cache,
            ...opts.cache,
        }
        // NOTE: sidechain and storageNode settings are not merged with the defaults
    }

    options.auth = options.auth || {}

    if ('privateKey' in options.auth) {
        const { privateKey } = options.auth
        if (typeof privateKey === 'string' && !privateKey.startsWith('0x')) {
            options.auth.privateKey = `0x${options.auth!.privateKey}`
        }
    }

    return options
}

export const validateConfig = (data: unknown): void | never => {
    const ajv = new Ajv()
    addFormats(ajv)
    ajv.addFormat('ethereum-address', /^0x[a-zA-Z0-9]{40}$/)
    ajv.addFormat('ethereum-private-key', /^(0x)?[a-zA-Z0-9]{64}$/)
    if (!ajv.validate(CONFIG_SCHEMA, data)) {
        throw new Error(ajv.errors!.map((e: ErrorObject) => {
            let text = ajv.errorsText([e], { dataVar: '' }).trim()
            if (e.params.additionalProperty) {
                text += `: ${e.params.additionalProperty}`
            }
            return text
        }).join('\n'))
    }
}

/**
 * DI Injection tokens for pieces of config.
 * tsyringe needs a concrete value to use as the injection token.
 * In the case of interfaces & types, these have no runtime value
 * so we have to introduce some token to use for their injection.
 * These symbols represent subsections of the full config.
 *
 * For example:
 * config.ethereum can be injected with a token like: @inject(ConfigInjectionToken.Ethereum)
 */
export const ConfigInjectionToken = {
    Root: Symbol('Config.Root'),
    Auth: Symbol('Config.Auth'),
    Ethereum: Symbol('Config.Ethereum'),
    Network: Symbol('Config.Network'),
    Connection: Symbol('Config.Connection'),
    Subscribe: Symbol('Config.Subscribe'),
    Publish: Symbol('Config.Publish'),
    Cache: Symbol('Config.Cache'),
    StorageNodeRegistry: Symbol('Config.StorageNodeRegistry'),
    Encryption: Symbol('Config.Encryption'),
    Timeouts: Symbol('Config.Timeouts')
}
