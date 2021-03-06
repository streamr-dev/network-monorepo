/**
 * Decrypt StreamMessages in-place.
 */
import { StreamMessage } from 'streamr-client-protocol'

import { EncryptionUtil, UnableToDecryptError } from '../encryption/EncryptionUtil'
import { SubscriberKeyExchange } from '../encryption/SubscriberKeyExchange'
import { StreamRegistryCached } from '../registry/StreamRegistryCached'
import { Context } from '../utils/Context'
import { DestroySignal } from '../DestroySignal'
import { instanceId } from '../utils/utils'

export class Decrypt<T> implements Context {
    readonly id
    readonly debug
    private isStopped = false

    constructor(
        context: Context,
        private streamRegistryCached: StreamRegistryCached,
        private keyExchange: SubscriberKeyExchange,
        private destroySignal: DestroySignal,
    ) {
        this.id = instanceId(this)
        this.debug = context.debug.extend(this.id)
        this.decrypt = this.decrypt.bind(this)
        this.destroySignal.onDestroy.listen(async () => {
            if (!this.isStopped) {
                await this.stop()
            }
        })
    }

    async decrypt(streamMessage: StreamMessage<T>): Promise<StreamMessage<T>> {
        if (this.isStopped) {
            return streamMessage
        }

        if (!streamMessage.groupKeyId) {
            return streamMessage
        }

        if (streamMessage.encryptionType !== StreamMessage.ENCRYPTION_TYPES.AES) {
            return streamMessage
        }

        try {
            const groupKey = await this.keyExchange.getGroupKey(streamMessage).catch((err) => {
                throw new UnableToDecryptError(streamMessage, `Could not get GroupKey: ${streamMessage.groupKeyId} – ${err.stack}`)
            })

            if (!groupKey) {
                throw new UnableToDecryptError(streamMessage, [
                    `Could not get GroupKey: ${streamMessage.groupKeyId}`,
                    'Publisher is offline, key does not exist or no permission to access key.',
                ].join(' '))
            }

            if (this.isStopped) { 
                return streamMessage
            }
            const clone = StreamMessage.deserialize(streamMessage.serialize())
            EncryptionUtil.decryptStreamMessage(clone, groupKey)
            await this.keyExchange.addNewKey(clone)
            return clone as StreamMessage<T>
        } catch (err) {
            if (this.isStopped) { 
                return streamMessage
            }
            this.debug('Decrypt Error', err)
            // clear cached permissions if cannot decrypt, likely permissions need updating
            this.streamRegistryCached.clearStream(streamMessage.getStreamId())
            throw err
        }
    }

    async stop(): Promise<void> {
        this.debug('stop')
        this.isStopped = true
    }
}
