/**
 * Wrapper for Stream metadata and (some) methods.
 */
import { DependencyContainer, inject } from 'tsyringe'

import { inspect } from './utils/log'

import { Resends } from './subscribe/Resends'
import { Publisher } from './publish/Publisher'
import { StreamRegistry } from './registry/StreamRegistry'
import { BrubeckContainer } from './Container'
import { StreamRegistryCached } from './registry/StreamRegistryCached'
import {
    EthereumAddress,
    StreamID,
    StreamMessage,
    StreamPartID,
    toStreamPartID
} from 'streamr-client-protocol'
import { range } from 'lodash'
import { ConfigInjectionToken, TimeoutsConfig } from './Config'
import { PermissionAssignment, PublicPermissionQuery, UserPermissionQuery } from './permission'
import { Subscriber } from './subscribe/Subscriber'
import { formStorageNodeAssignmentStreamId } from './utils/utils'
import { waitForAssignmentsToPropagate } from './utils/waitForAssignmentsToPropagate'
import { InspectOptions } from 'util'
import { MessageMetadata } from './index-exports'
import { StreamStorageRegistry } from './registry/StreamStorageRegistry'
import { withTimeout } from '@streamr/utils'
import { StreamMetadata } from './StreamMessageValidator'

export interface StreamProperties {
    id: string
    description?: string
    config?: {
        fields: Field[]
    }
    partitions?: number
    storageDays?: number
    inactivityThresholdHours?: number
}

/** @internal */
export interface StreamrStreamConstructorOptions extends StreamProperties {
    id: StreamID
}

export const VALID_FIELD_TYPES = ['number', 'string', 'boolean', 'list', 'map'] as const

export interface Field {
    name: string
    type: typeof VALID_FIELD_TYPES[number]
}

function getFieldType(value: any): (Field['type'] | undefined) {
    const type = typeof value
    switch (true) {
        case Array.isArray(value): {
            return 'list'
        }
        case type === 'object': {
            return 'map'
        }
        case (VALID_FIELD_TYPES as ReadonlyArray<string>).includes(type): {
            // see https://github.com/microsoft/TypeScript/issues/36275
            return type as Field['type']
        }
        default: {
            return undefined
        }
    }
}

/**
 * @category Important
 */
class StreamrStream implements StreamMetadata {
    id: StreamID
    description?: string
    config: {
        fields: Field[]
    } = { fields: [] }
    partitions!: number
    storageDays?: number
    inactivityThresholdHours?: number
    protected _resends: Resends
    protected _publisher: Publisher
    protected _subscriber: Subscriber
    protected _streamRegistry: StreamRegistry
    protected _streamRegistryCached: StreamRegistryCached
    protected _streamStorageRegistry: StreamStorageRegistry
    private _timeoutsConfig: TimeoutsConfig

    /** @internal */
    constructor(
        props: StreamrStreamConstructorOptions,
        @inject(BrubeckContainer) _container: DependencyContainer
    ) {
        Object.assign(this, props)
        this.id = props.id
        this.partitions = props.partitions ? props.partitions : 1
        this._resends = _container.resolve<Resends>(Resends)
        this._publisher = _container.resolve<Publisher>(Publisher)
        this._subscriber = _container.resolve<Subscriber>(Subscriber)
        this._streamRegistryCached = _container.resolve<StreamRegistryCached>(StreamRegistryCached)
        this._streamRegistry = _container.resolve<StreamRegistry>(StreamRegistry)
        this._streamStorageRegistry = _container.resolve<StreamStorageRegistry>(StreamStorageRegistry)
        this._timeoutsConfig = _container.resolve<TimeoutsConfig>(ConfigInjectionToken.Timeouts)
    }

    /**
     * Persist stream metadata updates.
     */
    async update(props: Omit<StreamProperties, 'id'>): Promise<void> {
        try {
            await this._streamRegistry.updateStream({
                ...this.toObject(),
                ...props,
                id: this.id
            })
        } finally {
            this._streamRegistryCached.clearStream(this.id)
        }
        for (const key of Object.keys(props)) {
            (this as any)[key] = (props as any)[key]
        }
    }

    getStreamParts(): StreamPartID[] {
        return range(0, this.partitions).map((p) => toStreamPartID(this.id, p))
    }

    toObject(): StreamProperties {
        const result: any = {}
        Object.keys(this).forEach((key) => {
            if (key.startsWith('_') || typeof key === 'function') { return }
            result[key] = (this as any)[key]
        })
        return result as StreamProperties
    }

    async delete(): Promise<void> {
        try {
            await this._streamRegistry.deleteStream(this.id)
        } finally {
            this._streamRegistryCached.clearStream(this.id)
        }
    }

    async detectFields(): Promise<void> {
        // Get last message of the stream to be used for field detecting
        const sub = await this._resends.resend(
            this.id,
            {
                last: 1,
            }
        )

        const receivedMsgs = await sub.collectContent()

        if (!receivedMsgs.length) { return }

        const [lastMessage] = receivedMsgs

        const fields = Object.entries(lastMessage).map(([name, value]) => {
            const type = getFieldType(value)
            return !!type && {
                name,
                type,
            }
        }).filter(Boolean) as Field[] // see https://github.com/microsoft/TypeScript/issues/30621

        // Save field config back to the stream
        await this.update({
            config: {
                fields
            }
        })
    }

    /**
     * @category Important
     */
    async addToStorageNode(nodeAddress: EthereumAddress, waitOptions: { timeout?: number } = {}): Promise<void> {
        let assignmentSubscription
        try {
            assignmentSubscription = await this._subscriber.subscribe(formStorageNodeAssignmentStreamId(nodeAddress))
            const propagationPromise = waitForAssignmentsToPropagate(assignmentSubscription, this)
            await this._streamStorageRegistry.addStreamToStorageNode(this.id, nodeAddress)
            await withTimeout(
                propagationPromise,
                // eslint-disable-next-line no-underscore-dangle
                waitOptions.timeout ?? this._timeoutsConfig.storageNode.timeout,
                'storage node did not respond'
            )
        } finally {
            this._streamRegistryCached.clearStream(this.id)
            await assignmentSubscription?.unsubscribe() // should never reject...
        }
    }

    /**
     * @category Important
     */
    async removeFromStorageNode(nodeAddress: EthereumAddress): Promise<void> {
        try {
            return this._streamStorageRegistry.removeStreamFromStorageNode(this.id, nodeAddress)
        } finally {
            this._streamRegistryCached.clearStream(this.id)
        }
    }

    async getStorageNodes(): Promise<string[]> {
        return this._streamStorageRegistry.getStorageNodes(this.id)
    }

    /**
     * @category Important
     */
    async publish<T>(content: T, metadata?: MessageMetadata): Promise<StreamMessage<T>> {
        return this._publisher.publish(this.id, content, metadata)
    }

    /** @internal */
    static parsePropertiesFromMetadata(propsString: string): StreamProperties {
        try {
            return JSON.parse(propsString)
        } catch (error) {
            throw new Error(`Could not parse properties from onchain metadata: ${propsString}`)
        }
    }

    /**
     * @category Important
     */
    async hasPermission(query: Omit<UserPermissionQuery, 'streamId'> | Omit<PublicPermissionQuery, 'streamId'>): Promise<boolean> {
        return this._streamRegistry.hasPermission({
            streamId: this.id,
            ...query
        })
    }

    /**
     * @category Important
     */
    async getPermissions(): Promise<PermissionAssignment[]> {
        return this._streamRegistry.getPermissions(this.id)
    }

    /**
     * @category Important
     */
    async grantPermissions(...assignments: PermissionAssignment[]): Promise<void> {
        return this._streamRegistry.grantPermissions(this.id, ...assignments)
    }

    /**
     * @category Important
     */
    async revokePermissions(...assignments: PermissionAssignment[]): Promise<void> {
        return this._streamRegistry.revokePermissions(this.id, ...assignments)
    }

    [Symbol.for('nodejs.util.inspect.custom')](depth: number, options: InspectOptions): string {
        return inspect(this.toObject(), {
            ...options,
            customInspect: false,
            depth,
        })
    }
}

export {
    StreamrStream as Stream
}
