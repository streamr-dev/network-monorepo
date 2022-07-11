import crypto, { CipherKey } from 'crypto'
import { arrayify, hexlify } from '@ethersproject/bytes'
import { StreamMessage, EncryptedGroupKey, StreamMessageError } from 'streamr-client-protocol'
import { GroupKey } from './GroupKey'

export class UnableToDecryptError extends StreamMessageError {
    constructor(message = '', streamMessage: StreamMessage) {
        super(`Unable to decrypt. ${message}`, streamMessage)
    }
}

export class EncryptionUtil {
    private static validateRSAPublicKey(publicKey: crypto.KeyLike): void|never {
        const keyString = typeof publicKey === 'string' ? publicKey : publicKey.toString('utf8')
        if (typeof keyString !== 'string' || !keyString.startsWith('-----BEGIN PUBLIC KEY-----')
            || !keyString.endsWith('-----END PUBLIC KEY-----\n')) {
            throw new Error('"publicKey" must be a PKCS#8 RSA public key in the PEM format')
        }
    }

    /**
     * Returns a Buffer or a hex String
     */
    /* eslint-disable no-dupe-class-members */
    static encryptWithRSAPublicKey(plaintextBuffer: Uint8Array, publicKey: crypto.KeyLike, outputInHex: true): string
    // These overrides tell ts outputInHex returns string
    static encryptWithRSAPublicKey(plaintextBuffer: Uint8Array, publicKey: crypto.KeyLike): string
    static encryptWithRSAPublicKey(plaintextBuffer: Uint8Array, publicKey: crypto.KeyLike, outputInHex: false): Buffer
    static encryptWithRSAPublicKey(plaintextBuffer: Uint8Array, publicKey: crypto.KeyLike, outputInHex: boolean = false): string | Buffer {
        this.validateRSAPublicKey(publicKey)
        const ciphertextBuffer = crypto.publicEncrypt(publicKey, plaintextBuffer)
        if (outputInHex) {
            return hexlify(ciphertextBuffer).slice(2)
        }
        return ciphertextBuffer
    }
    /* eslint-disable no-dupe-class-members */

    // Returns a Buffer
    static decryptWithRSAPrivateKey(ciphertext: string | Uint8Array, privateKey: crypto.KeyLike, isHexString = false): Buffer {
        const ciphertextBuffer = isHexString ? arrayify(`0x${ciphertext}`) : ciphertext as Uint8Array
        return crypto.privateDecrypt(privateKey, ciphertextBuffer)
    }

    /*
     * Returns a hex string without the '0x' prefix.
     */
    static encryptWithAES(data: Uint8Array, cipherKey: CipherKey): string {
        const iv = crypto.randomBytes(16) // always need a fresh IV when using CTR mode
        const cipher = crypto.createCipheriv('aes-256-ctr', cipherKey, iv)
        return hexlify(iv).slice(2) + cipher.update(data, undefined, 'hex') + cipher.final('hex')
    }

    /*
     * 'ciphertext' must be a hex string (without '0x' prefix), 'groupKey' must be a GroupKey. Returns a Buffer.
     */
    static decryptWithAES(ciphertext: string, cipherKey: CipherKey): Buffer {
        const iv = arrayify(`0x${ciphertext.slice(0, 32)}`)
        const decipher = crypto.createDecipheriv('aes-256-ctr', cipherKey, iv)
        return Buffer.concat([decipher.update(ciphertext.slice(32), 'hex'), decipher.final()])
    }

    /*
     * Sets the content of 'streamMessage' with the encryption result of the old content with 'groupKey'.
     */
    // TODO remove this method
    static encryptStreamMessage(streamMessage: StreamMessage, groupKey: GroupKey, nextGroupKey?: GroupKey): void {
        /* eslint-disable no-param-reassign */
        streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.AES
        streamMessage.groupKeyId = groupKey.id
        streamMessage.serializedContent = this.encryptWithAES(Buffer.from(streamMessage.getSerializedContent(), 'utf8'), groupKey.data)
        if (nextGroupKey) {
            streamMessage.newGroupKey = EncryptionUtil.encryptGroupKey(nextGroupKey, groupKey)
        }
        streamMessage.parsedContent = undefined
        /* eslint-enable no-param-reassign */
    }

    static decryptStreamMessage(streamMessage: StreamMessage, groupKey: GroupKey): void | never {
        if ((streamMessage.encryptionType !== StreamMessage.ENCRYPTION_TYPES.AES)) {
            return
        }

        /* eslint-disable no-param-reassign */
        try {
            streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.NONE
            const serializedContent = this.decryptWithAES(streamMessage.getSerializedContent(), groupKey.data).toString()
            streamMessage.parsedContent = JSON.parse(serializedContent)
            streamMessage.serializedContent = serializedContent
        } catch (err) {
            streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.AES
            throw new UnableToDecryptError(err.stack, streamMessage)
        }

        try {
            const { newGroupKey } = streamMessage
            if (newGroupKey) {
                // newGroupKey should be EncryptedGroupKey | GroupKey, but GroupKey is not defined in protocol
                // @ts-expect-error expecting EncryptedGroupKey
                streamMessage.newGroupKey = EncryptionUtil.decryptGroupKey(newGroupKey, groupKey)
            }
        } catch (err) {
            streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.AES
            throw new UnableToDecryptError('Could not decrypt new group key: ' + err.stack, streamMessage)
        }
        /* eslint-enable no-param-reassign */
    }

    static encryptGroupKey(nextGroupKey: GroupKey, currentGroupKey: GroupKey): EncryptedGroupKey {
        return new EncryptedGroupKey(nextGroupKey.id, this.encryptWithAES(nextGroupKey.data, currentGroupKey.data))
    }

    static decryptGroupKey(newGroupKey: EncryptedGroupKey, currentGroupKey: GroupKey): GroupKey {
        return GroupKey.from([
            newGroupKey.groupKeyId,
            this.decryptWithAES(newGroupKey.encryptedGroupKeyHex, currentGroupKey.data)
        ])
    }
}

