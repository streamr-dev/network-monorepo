const { startNetworkNode, startStorageNode } = require('streamr-network')
const StreamrClient = require('streamr-client')
const publicIp = require('public-ip')
const Sentry = require('@sentry/node')

const CURRENT_VERSION = require('../package.json').version

const StreamFetcher = require('./StreamFetcher')
const { startCassandraStorage } = require('./Storage')
const Publisher = require('./Publisher')
const VolumeLogger = require('./VolumeLogger')
const SubscriptionManager = require('./SubscriptionManager')
const MissingConfigError = require('./errors/MissingConfigError')
const adapterRegistry = require('./adapterRegistry')

module.exports = async (config) => {
    // Validate that configuration exists
    if (config.network === undefined) {
        throw new MissingConfigError('network')
    }
    if (config.network.id === undefined) {
        throw new MissingConfigError('network.id')
    }
    if (config.network.hostname === undefined) {
        throw new MissingConfigError('network.hostname')
    }
    if (config.network.port === undefined) {
        throw new MissingConfigError('network.port')
    }
    if (config.network.advertisedWsUrl === undefined) {
        throw new MissingConfigError('network.advertisedWsUrl')
    }
    if (config.network.tracker === undefined) {
        throw new MissingConfigError('network.tracker')
    }
    if (config.network.isStorageNode === undefined) {
        throw new MissingConfigError('network.isStorageNode')
    }
    if (config.cassandra === undefined) {
        throw new MissingConfigError('cassandra')
    }
    if (config.cassandra && config.cassandra.hosts === undefined) {
        throw new MissingConfigError('cassandra.hosts')
    }
    if (config.cassandra && config.cassandra.username === undefined) {
        throw new MissingConfigError('cassandra.username')
    }
    if (config.cassandra && config.cassandra.password === undefined) {
        throw new MissingConfigError('cassandra.password')
    }
    if (config.cassandra && config.cassandra.keyspace === undefined) {
        throw new MissingConfigError('cassandra.keyspace')
    }
    if (config.streamrUrl === undefined) {
        throw new MissingConfigError('streamrUrl')
    }
    if (config.adapters === undefined) {
        throw new MissingConfigError('adapters')
    }
    if (config.reporting === undefined) {
        throw new MissingConfigError('reporting')
    }
    if (config.reporting && (config.reporting.streamId !== undefined || config.reporting.apiKey !== undefined)) {
        if (config.reporting.apiKey === undefined) {
            throw new MissingConfigError('reporting.apiKey')
        }
        if (config.reporting.streamId === undefined) {
            throw new MissingConfigError('reporting.streamId')
        }
    }
    if (config.reporting && config.reporting.reportingIntervalSeconds === undefined) {
        throw new MissingConfigError('reporting.reportingIntervalSeconds')
    }
    if (config.sentry === undefined) {
        throw new MissingConfigError('sentry')
    }

    config.adapters.forEach(({ name }, index) => {
        if (name === undefined) {
            throw new MissingConfigError(`adapters[${index}].name`)
        }
    })

    console.info(`Starting broker version ${CURRENT_VERSION}`)

    const storages = []

    // Start cassandra storage
    if (config.cassandra) {
        console.info(`Starting Cassandra with hosts ${config.cassandra.hosts} and keyspace ${config.cassandra.keyspace}`)
        storages.push(await startCassandraStorage({
            contactPoints: [...config.cassandra.hosts],
            localDataCenter: 'datacenter1',
            keyspace: config.cassandra.keyspace,
            username: config.cassandra.username,
            password: config.cassandra.password,
            useTtl: !config.network.isStorageNode
        }))
    } else {
        console.info('Cassandra disabled')
    }

    // Start network node
    const startFn = config.network.isStorageNode ? startStorageNode : startNetworkNode
    const advertisedWsUrl = config.network.advertisedWsUrl !== 'auto'
        ? config.network.advertisedWsUrl
        : await publicIp.v4().then((ip) => `ws://${ip}:${config.network.port}`)
    const networkNode = await startFn(
        config.network.hostname,
        config.network.port,
        config.network.id,
        storages,
        advertisedWsUrl
    )
    networkNode.addBootstrapTracker(config.network.tracker)

    if (config.sentry) {
        Sentry.init({
            dsn: config.sentry,
            integrations: [
                new Sentry.Integrations.Console({
                    levels: ['error']
                })
            ],
            environment: 'broker',
            maxBreadcrumbs: 50,
            attachStacktrace: true,

        })

        Sentry.configureScope((scope) => {
            scope.setUser({
                id: config.network.id
            })
        })
    }

    let client
    const { apiKey, streamId } = config.reporting
    if (config.reporting && streamId !== undefined && apiKey !== undefined) {
        console.info(`Starting StreamrClient reporting with apiKey: ${apiKey} and streamId: ${streamId}`)
        client = new StreamrClient({
            auth: {
                apiKey
            },
            autoConnect: false
        })
    } else {
        console.info('StreamrClient reporting disabled')
    }

    // Initialize common utilities
    const volumeLogger = new VolumeLogger(
        config.reporting.reportingIntervalSeconds,
        networkNode,
        client,
        streamId
    )
    const streamFetcher = new StreamFetcher(config.streamrUrl)
    const publisher = new Publisher(networkNode, volumeLogger)
    const subscriptionManager = new SubscriptionManager(networkNode)

    // Start up adapters one-by-one, storing their close functions for further use
    const closeAdapterFns = config.adapters.map(({ name, ...adapterConfig }, index) => {
        try {
            return adapterRegistry.startAdapter(name, adapterConfig, {
                networkNode,
                publisher,
                streamFetcher,
                volumeLogger,
                subscriptionManager
            })
        } catch (e) {
            if (e instanceof MissingConfigError) {
                throw new MissingConfigError(`adapters[${index}].${e.config}`)
            }
            return () => {}
        }
    })

    console.info(`Network node '${config.network.id}' running on ${config.network.hostname}:${config.network.port}`)
    console.info(`Configured with tracker: ${config.network.tracker}`)
    console.info(`Adapters: ${JSON.stringify(config.adapters.map((a) => a.name))}`)
    if (config.cassandra) {
        console.info(`Configured with Cassandra: hosts=${config.cassandra.hosts} and keyspace=${config.cassandra.keyspace}`)
    }
    console.info(`Configured with Streamr: ${config.streamrUrl}`)
    if (advertisedWsUrl) {
        console.info(`Advertising to tracker WS url: ${advertisedWsUrl}`)
    }

    return {
        getStreams: () => networkNode.getStreams(),
        close: () => Promise.all([
            networkNode.stop(),
            ...closeAdapterFns.map((close) => close()),
            ...storages.map((storage) => storage.close()),
            volumeLogger.close()
        ])
    }
}
