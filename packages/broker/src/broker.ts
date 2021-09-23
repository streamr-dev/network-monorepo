import { createNetworkNode, Protocol, MetricsContext } from 'streamr-network'
import {
    getTrackerRegistryFromContract,
    getStorageNodeRegistryFromContract,
    CachingStreamMessageValidator,
    SmartContractConfig,
    StorageNodeRecord,
    TrackerRecord,
} from 'streamr-network/dist/streamr-client-protocol'
import StreamrClient from 'streamr-client'
import { Wallet } from 'ethers'
import { Logger } from 'streamr-network'
import { Server as HttpServer } from 'http'
import { Server as HttpsServer } from 'https'
import { Publisher } from './Publisher'
import { SubscriptionManager } from './SubscriptionManager'
import { createPlugin } from './pluginRegistry'
import { validateConfig } from './helpers/validateConfig'
import { version as CURRENT_VERSION } from '../package.json'
import { Config } from './config'
import { Plugin, PluginOptions } from './Plugin'
import { startServer as startHttpServer, stopServer } from './httpServer'
import BROKER_CONFIG_SCHEMA from './helpers/config.schema.json'
import { createLocalStreamrClient } from './localStreamrClient'
import { createApiAuthenticator } from './apiAuthenticator'
import { StorageNodeRegistry } from "./StorageNodeRegistry"
import { v4 as uuidv4 } from 'uuid'

const logger = new Logger(module)

export interface Broker {
    getNeighbors: () => readonly string[]
    getStreams: () => readonly string[]
    start: () => Promise<unknown>
    stop: () => Promise<unknown>
}

const getTrackers = async (config: Config): Promise<TrackerRecord[]> => {
    if ((config.network.trackers as SmartContractConfig).contractAddress) {
        const registry = await getTrackerRegistryFromContract(config.network.trackers as SmartContractConfig)
        return registry.getAllTrackers()
    } else {
        return config.network.trackers as TrackerRecord[]
    }
}

const getStorageNodes = async (config: Config): Promise<StorageNodeRecord[]> => {
    if ((config.storageNodeConfig.registry as SmartContractConfig).contractAddress) {
        const registry = await getStorageNodeRegistryFromContract(config.storageNodeConfig.registry as SmartContractConfig)
        return registry.getAllStorageNodes()
    } else {
        return config.storageNodeConfig.registry as StorageNodeRecord[]
    }
}

const getStunTurnUrls = (config: Config): string[] | undefined => {
    if (!config.network.stun && !config.network.turn) {
        return undefined
    }
    const urls = []
    if (config.network.stun) {
        urls.push(config.network.stun)
    }
    if (config.network.turn) {
        const parsedUrl = config.network.turn.url.replace('turn:', '')
        const turn = `turn:${config.network.turn.username}:${config.network.turn.password}@${parsedUrl}`
        urls.push(turn)
    }
    return urls
}

const createStreamMessageValidator = (config: Config): Protocol.StreamMessageValidator => {
    // Validator only needs public information, so use unauthenticated client for that
    const unauthenticatedClient = new StreamrClient({
        restUrl: config.streamrUrl + '/api/v1',
    })
    return new CachingStreamMessageValidator({
        getStream: (sId) => unauthenticatedClient.getStreamValidationInfo(sId),
        isPublisher: (address, sId) => unauthenticatedClient.isStreamPublisher(sId, address),
        isSubscriber: (address, sId) => unauthenticatedClient.isStreamSubscriber(sId, address),
    })
}

export const createBroker = async (config: Config): Promise<Broker> => {
    validateConfig(config, BROKER_CONFIG_SCHEMA)

    const networkNodeName = config.network.name
    const metricsContext = new MetricsContext(networkNodeName)

    // Ethereum wallet retrieval
    const wallet = new Wallet(config.ethereumPrivateKey)
    if (!wallet) {
        throw new Error('Could not resolve Ethereum address from given config.ethereumPrivateKey')
    }
    const brokerAddress = wallet.address

    const trackers = await getTrackers(config)

    const storageNodes = await getStorageNodes(config)
    const storageNodeRegistry = StorageNodeRegistry.createInstance(config, storageNodes)

    // Start network node
    let sessionId
    if (config.generateSessionId && !config.plugins['storage']) { // Exception: storage node needs consistent id
        sessionId = `${brokerAddress}#${uuidv4()}`
    }
    const nodeId = sessionId || brokerAddress

    const networkNode = createNetworkNode({
        id: nodeId,
        name: networkNodeName,
        trackers,
        location: config.network.location,
        metricsContext,
        stunUrls: getStunTurnUrls(config)
    })

    const publisher = new Publisher(networkNode, createStreamMessageValidator(config), metricsContext)
    const subscriptionManager = new SubscriptionManager(networkNode)
    const localStreamrClient = createLocalStreamrClient(config)
    const apiAuthenticator = createApiAuthenticator(config)

    const plugins: Plugin<any>[] = Object.keys(config.plugins).map((name) => {
        const pluginOptions: PluginOptions = {
            name,
            networkNode,
            subscriptionManager,
            publisher,
            streamrClient: localStreamrClient,
            apiAuthenticator,
            metricsContext,
            brokerConfig: config,
            storageNodeRegistry,
            nodeId
        }
        return createPlugin(name, pluginOptions)
    })

    let httpServer: HttpServer|HttpsServer|undefined

    return {
        getNeighbors: () => networkNode.getNeighbors(),
        getStreams: () => networkNode.getStreams(),
        start: async () => {
            logger.info(`Starting broker version ${CURRENT_VERSION}`)
            await networkNode.start()
            await Promise.all(plugins.map((plugin) => plugin.start()))
            const httpServerRoutes = plugins.flatMap((plugin) => plugin.getHttpServerRoutes())
            if (httpServerRoutes.length > 0) {
                httpServer = await startHttpServer(httpServerRoutes, config.httpServer, apiAuthenticator)
            }

            logger.info(`Welcome to the Streamr Network. Your node's generated name is ${Protocol.generateMnemonicFromAddress(brokerAddress)}.`)
            logger.info(`View your node in the Network Explorer: https://streamr.network/network-explorer/nodes/${brokerAddress}`)

            logger.info(`Network node '${networkNodeName}' (id=${nodeId}) running`)
            logger.info(`Ethereum address ${brokerAddress}`)
            logger.info(`Configured with trackers: [${trackers.map((tracker) => tracker.http).join(', ')}]`)
            logger.info(`Configured with Streamr: ${config.streamrUrl}`)
            logger.info(`Plugins: ${JSON.stringify(plugins.map((p) => p.name))}`)
        },
        stop: async () => {
            if (httpServer !== undefined) {
                await stopServer(httpServer)
            }
            await Promise.all(plugins.map((plugin) => plugin.stop()))
            if (localStreamrClient !== undefined) {
                await localStreamrClient.ensureDisconnected()
            }
            await networkNode.stop()
        }
    }
}

process.on('uncaughtException', (err) => {
    logger.getFinalLogger().error(err, 'uncaughtException')
    process.exit(1)
})

process.on('unhandledRejection', (err) => {
    logger.getFinalLogger().error(err, 'unhandledRejection')
    process.exit(1)
})
