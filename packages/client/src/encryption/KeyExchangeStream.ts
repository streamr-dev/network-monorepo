import {
    StreamMessage,
    GroupKeyRequest,
    GroupKeyResponse,
    GroupKeyResponseSerialized,
    GroupKeyErrorResponse,
    GroupKeyErrorResponseSerialized,
    EthereumAddress,
    KeyExchangeStreamIDUtils
} from 'streamr-client-protocol'
import { Lifecycle, scoped, delay, inject } from 'tsyringe'

import { instanceId } from '../utils/utils'
import { pOnce } from '../utils/promises'
import { Context } from '../utils/Context'
import { DestroySignal } from '../DestroySignal'

import { Subscriber } from '../subscribe/Subscriber'
import { Publisher } from '../publish/Publisher'
import { Subscription } from '../subscribe/Subscription'

import { GroupKey, GroupKeyish } from './GroupKey'
import { publishAndWaitForResponseMessage } from '../utils/waitForMessage'
import { Authentication, AuthenticationInjectionToken } from '../Authentication'
import { ConfigInjectionToken, TimeoutsConfig } from '../Config'

export type GroupKeyId = string
export type GroupKeysSerialized = Record<GroupKeyId, GroupKeyish>

export type EncryptionConfig = {
    encryptionKeys: Record<string, GroupKeysSerialized>
}

export function parseGroupKeys(groupKeys: GroupKeysSerialized = {}): Map<GroupKeyId, GroupKey> {
    return new Map<GroupKeyId, GroupKey>(Object.entries(groupKeys || {}).map(([key, value]) => {
        if (!value || !key) { return null }
        return [key, GroupKey.from(value)]
    }).filter(Boolean) as [])
}

const { GROUP_KEY_RESPONSE, GROUP_KEY_ERROR_RESPONSE } = StreamMessage.MESSAGE_TYPES

@scoped(Lifecycle.ContainerScoped)
export class KeyExchangeStream implements Context {
    readonly id
    readonly debug
    public subscribe: (() => Promise<Subscription<unknown>>) & { reset(): void }
    
    constructor(
        context: Context,
        @inject(AuthenticationInjectionToken) private authentication: Authentication,
        private subscriber: Subscriber,
        private destroySignal: DestroySignal,
        @inject(delay(() => Publisher)) private publisher: Publisher,
        @inject(ConfigInjectionToken.Timeouts) private timeoutsConfig: TimeoutsConfig
    ) {
        this.id = instanceId(this)
        this.debug = context.debug.extend(this.id)
        this.subscribe = pOnce(this.createSubscription.bind(this))
    }

    private async createSubscription(): Promise<Subscription<unknown>> {
        // subscribing to own keyexchange stream
        const publisherId = await this.authentication.getAddress()
        const streamPartId = KeyExchangeStreamIDUtils.formStreamPartID(publisherId)
        const sub = await this.subscriber.subscribe(streamPartId)
        const onDestroy = () => {
            return sub.unsubscribe()
        }
        this.destroySignal.onDestroy.listen(onDestroy)
        sub.onBeforeFinally.listen(() => {
            this.destroySignal.onDestroy.unlisten(onDestroy)
            this.subscribe.reset()
        })
        return sub
    }

    async request(publisherId: EthereumAddress, request: GroupKeyRequest): Promise<StreamMessage<unknown> | undefined> {
        const streamPartId = KeyExchangeStreamIDUtils.formStreamPartID(publisherId)

        const matchFn = (streamMessage: StreamMessage) => {
            const { messageType } = streamMessage
            if (messageType !== GROUP_KEY_RESPONSE && messageType !== GROUP_KEY_ERROR_RESPONSE) {
                return false
            }
            const content = streamMessage.getContent() as any
            return GroupKeyResponse.fromArray(content).requestId === request.requestId
        }

        return publishAndWaitForResponseMessage(
            () => this.publisher.publish(streamPartId, request.toArray(), {
                messageType: StreamMessage.MESSAGE_TYPES.GROUP_KEY_REQUEST,
                encryptionType: StreamMessage.ENCRYPTION_TYPES.NONE
            }),
            matchFn,
            () => this.createSubscription(),
            () => this.subscribe.reset(),
            this.destroySignal,
            this.timeoutsConfig.encryptionKeyRequest
        )
    }

    async response(
        subscriberId: EthereumAddress, 
        response: GroupKeyResponse | GroupKeyErrorResponse
    ): Promise<StreamMessage<GroupKeyResponseSerialized | GroupKeyErrorResponseSerialized>> {
        const content = response.toArray()
        const encryptionType = (response.messageType === StreamMessage.MESSAGE_TYPES.GROUP_KEY_RESPONSE) 
            ? StreamMessage.ENCRYPTION_TYPES.RSA 
            : StreamMessage.ENCRYPTION_TYPES.NONE
        const metadata = {
            messageType: response.messageType,
            encryptionType
        }
        return this.publisher.publish(KeyExchangeStreamIDUtils.formStreamPartID(subscriberId), content, metadata)
    }
}
