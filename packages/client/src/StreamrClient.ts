import 'reflect-metadata'
import './utils/PatchTsyringe'
import { container as rootContainer, DependencyContainer, inject } from 'tsyringe'

import Ethereum from './Ethereum'
import { uuid, counterId, pOnce } from './utils'
import { Debug } from './utils/log'
import { Context } from './utils/Context'
import BrubeckConfig, { Config, StrictBrubeckClientConfig, BrubeckClientConfig } from './Config'
import { BrubeckContainer } from './Container'

import Publisher from './publish/Publisher'
import Subscriber from './subscribe/Subscriber'
import Resends, { ResendOptions } from './subscribe/Resends'
import { ResendSubscription } from './subscribe/ResendSubscription'
import BrubeckNode from './BrubeckNode'
import Session from './Session'
import { DestroySignal } from './DestroySignal'
import { StreamEndpoints } from './StreamEndpoints'
import { StreamEndpointsCached } from './StreamEndpointsCached'
import { LoginEndpoints } from './LoginEndpoints'
import DataUnions from './dataunion'
import GroupKeyStoreFactory from './encryption/GroupKeyStoreFactory'
import { StorageNodeRegistry } from './StorageNodeRegistry'
import { StreamRegistry } from './StreamRegistry'
import { Methods, Plugin } from './utils/Plugin'
import { StreamDefinition } from './types'
import { Subscription, SubscriptionOnMessage } from './subscribe/Subscription'
import { StreamIDBuilder } from './StreamIDBuilder'

let uid: string = process.pid != null
    // Use process id in node uid.
    ? `${process.pid}`
    // Fall back to `uuid()` later (see initContainer). Doing it here will break browser projects
    // that utilize server-side rendering (no `window` while build's target is `web`).
    : ''

// these are mixed in via Plugin function above
// use MethodNames to only grab methods
export interface StreamrClient extends Ethereum,
    Methods<StreamEndpoints>,
    Methods<Omit<Subscriber, 'subscribe'>>,
    Methods<StreamRegistry>,
    // connect/pOnce in BrubeckNode are pOnce, we override them anyway
    Methods<Omit<BrubeckNode, 'destroy' | 'connect'>>,
    Methods<LoginEndpoints>,
    Methods<Publisher>,
    Methods<StorageNodeRegistry>,
    Methods<DataUnions>,
    Methods<GroupKeyStoreFactory>,
    Methods<Session>,
    Methods<Resends> {
}

class StreamrClientBase implements Context {
    static generateEthereumAccount = Ethereum.generateEthereumAccount.bind(Ethereum)

    /** @internal */
    readonly id
    /** @internal */
    readonly debug
    /** @internal */
    onDestroy
    /** @internal */
    isDestroyed

    constructor(
        private container: DependencyContainer,
        private context: Context,
        @inject(Config.Root) private options: StrictBrubeckClientConfig,
        private node: BrubeckNode,
        private ethereum: Ethereum,
        private session: Session,
        private loginEndpoints: LoginEndpoints,
        private streamEndpoints: StreamEndpoints,
        private cached: StreamEndpointsCached,
        private resends: Resends,
        private publisher: Publisher,
        private subscriber: Subscriber,
        private groupKeyStore: GroupKeyStoreFactory,
        private destroySignal: DestroySignal,
        private dataunions: DataUnions,
        private streamRegistry: StreamRegistry,
        private storageNodeRegistry: StorageNodeRegistry,
        private streamIdBuilder: StreamIDBuilder
    ) { // eslint-disable-line function-paren-newline
        this.id = context.id
        this.debug = context.debug
        Plugin(this, this.loginEndpoints)
        Plugin(this, this.streamEndpoints)
        Plugin(this, this.ethereum)
        Plugin(this, this.publisher)
        Plugin(this, this.subscriber)
        Plugin(this, this.resends)
        Plugin(this, this.session)
        Plugin(this, this.node)
        Plugin(this, this.groupKeyStore)
        Plugin(this, this.dataunions)
        Plugin(this, this.streamRegistry)
        Plugin(this, this.storageNodeRegistry)

        this.onDestroy = this.destroySignal.onDestroy.bind(this.destroySignal)
        this.isDestroyed = this.destroySignal.isDestroyed.bind(this.destroySignal)
    }

    /**
     * @category Important
     */
    subscribe<T>(
        options: StreamDefinition & { resend: ResendOptions },
        onMessage?: SubscriptionOnMessage<T>
    ): Promise<ResendSubscription<T>>
    subscribe<T>(
        options: StreamDefinition,
        onMessage?: SubscriptionOnMessage<T>
    ): Promise<Subscription<T>>
    subscribe<T>(
        options: StreamDefinition & { resend?: ResendOptions },
        onMessage?: SubscriptionOnMessage<T>
    ): Promise<Subscription<T> | ResendSubscription<T>> {
        if (options.resend !== undefined) {
            return this.resendSubscribe(options, options.resend, onMessage)
        }

        return this.subscriber.subscribe(options, onMessage)
    }

    private async resendSubscribe<T>(
        streamDefinition: StreamDefinition,
        resendOptions: ResendOptions,
        onMessage?: SubscriptionOnMessage<T>
    ): Promise<ResendSubscription<T>> {
        const streamPartId = await this.streamIdBuilder.toStreamPartID(streamDefinition)
        const subSession = this.subscriber.getOrCreateSubscriptionSession<T>(streamPartId)
        const sub = new ResendSubscription<T>(subSession, this.resends, resendOptions, this.container)
        if (onMessage) {
            sub.useLegacyOnMessageHandler(onMessage)
        }
        await this.subscriber.addSubscription<T>(sub)
        return sub
    }

    connect = pOnce(async () => {
        await this.node.startNode()
        const tasks = [
            this.publisher.start(),
        ]

        await Promise.allSettled(tasks)
        await Promise.all(tasks)
    })

    destroy = pOnce(async () => {
        this.connect.reset() // reset connect (will error on next call)
        const tasks = [
            this.destroySignal.destroy().then(() => undefined),
            this.resends.stop(),
            this.publisher.stop(),
            this.subscriber.stop(),
        ]

        await Promise.allSettled(tasks)
        await Promise.all(tasks)
    })

    /** @internal */
    enableDebugLogging(prefix = 'Streamr*') { // eslint-disable-line class-methods-use-this
        Debug.enable(prefix)
    }

    /** @internal */
    disableDebugLogging() { // eslint-disable-line class-methods-use-this
        Debug.disable()
    }
}

/**
 * @internal
 */
export function initContainer(options: BrubeckClientConfig = {}, parentContainer = rootContainer) {
    const c = parentContainer.createChildContainer()
    const config = BrubeckConfig(options)
    uid = uid || `${uuid().slice(-4)}${uuid().slice(0, 4)}`
    const id = counterId(`StreamrClient:${uid}${config.id ? `:${config.id}` : ''}`)
    const debug = Debug(id)
    // @ts-expect-error not in types
    if (!debug.inspectOpts) {
        // @ts-expect-error not in types
        debug.inspectOpts = {}
    }
    // @ts-expect-error not in types
    Object.assign(debug.inspectOpts, {
        // @ts-expect-error not in types
        ...debug.inspectOpts,
        ...config.debug.inspectOpts
    })
    debug('create')

    const rootContext = {
        id,
        debug
    }

    c.register(Context as any, {
        useValue: rootContext
    })

    c.register(BrubeckContainer, {
        useValue: c
    })

    // associate values to config tokens
    const configTokens: [symbol, object][] = [
        [Config.Root, config],
        [Config.Auth, config.auth],
        [Config.Ethereum, config],
        [Config.Network, config.network],
        [Config.Connection, config],
        [Config.Subscribe, config],
        [Config.Publish, config],
        [Config.Encryption, config],
        [Config.Cache, config.cache],
    ]

    configTokens.forEach(([token, useValue]) => {
        c.register(token, { useValue })
    })

    return {
        config,
        childContainer: c,
        rootContext,
    }
}

/**
 * @category Important
 */
export class StreamrClient extends StreamrClientBase {
    constructor(options: BrubeckClientConfig = {}, parentContainer = rootContainer) {
        const { childContainer: c, config } = initContainer(options, parentContainer)
        super(
            c,
            c.resolve<Context>(Context as any),
            config,
            c.resolve<BrubeckNode>(BrubeckNode),
            c.resolve<Ethereum>(Ethereum),
            c.resolve<Session>(Session),
            c.resolve<LoginEndpoints>(LoginEndpoints),
            c.resolve<StreamEndpoints>(StreamEndpoints),
            c.resolve<StreamEndpointsCached>(StreamEndpointsCached),
            c.resolve<Resends>(Resends),
            c.resolve<Publisher>(Publisher),
            c.resolve<Subscriber>(Subscriber),
            c.resolve<GroupKeyStoreFactory>(GroupKeyStoreFactory),
            c.resolve<DestroySignal>(DestroySignal),
            c.resolve<DataUnions>(DataUnions),
            c.resolve<StreamRegistry>(StreamRegistry),
            c.resolve<StorageNodeRegistry>(StorageNodeRegistry),
            c.resolve<StreamIDBuilder>(StreamIDBuilder)
        )
    }
}

/** @internal */
export const Dependencies = {
    Context,
    BrubeckNode,
    StorageNodeRegistry,
    Session,
    LoginEndpoints,
    StreamEndpoints,
    StreamEndpointsCached,
    Resends,
    Publisher,
    Subscriber,
    GroupKeyStoreFactory,
    DestroySignal,
    DataUnions,
}

export { BrubeckClientConfig as StreamrClientOptions } from './Config'
