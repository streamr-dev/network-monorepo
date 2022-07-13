import 'reflect-metadata'
import { Wallet } from '@ethersproject/wallet'
import { EthereumAddress, MessageID, SigningUtil, StreamMessage, toStreamID } from 'streamr-client-protocol'
import { Stream } from '../../src/Stream'
import { StreamRegistry } from '../../src/StreamRegistry'
import { StreamRegistryCached } from '../../src/StreamRegistryCached'
import { Validator } from '../../src/Validator'
import { mockContext } from '../test-utils/utils'
import { STREAM_CLIENT_DEFAULTS, SubscribeConfig } from '../../src/Config'

const publisherWallet = Wallet.createRandom()
const PARTITION_COUNT = 3

const createMockValidator = (options: Partial<SubscribeConfig>) => {
    const streamRegistry: Pick<StreamRegistry,'getStream'|'isStreamPublisher'> = {
        getStream: async (): Promise<Stream> => {
            return {
                partitions: PARTITION_COUNT
            } as any
        },
        isStreamPublisher: async (_streamIdOrPath: string, userAddress: EthereumAddress) => {
            return userAddress.toLowerCase() === publisherWallet.address.toLowerCase()
        }
    }
    const context = mockContext()
    return new Validator(
        context,
        new StreamRegistryCached(context, streamRegistry as any, {} as any) as any,
        {
            ...STREAM_CLIENT_DEFAULTS,
            ...options
        } as any,
        {} as any
    )
}

interface MessageOptions {
    partition?: number
    publisher?: string
    privateKey?: string
    signature?: string
}

const createMockMessage = async ({
    partition = 0,
    publisher = publisherWallet.address,
    privateKey = publisherWallet.privateKey,
    signature
}: MessageOptions) => {
    const msg = new StreamMessage({
        messageId: new MessageID(toStreamID('streamId'), partition, 0, 0, publisher, 'msgChainId'),
        content: {
            foo: 'bar'
        },
        signatureType: StreamMessage.SIGNATURE_TYPES.ETH
    })
    msg.signature = (signature === undefined) 
        ? SigningUtil.sign(msg.getPayloadToSign(StreamMessage.SIGNATURE_TYPES.ETH), privateKey) 
        : signature
    return msg
}

const validate = async (messageOptions: MessageOptions, validatorOptions: Partial<SubscribeConfig> = {}) => {
    const validator = createMockValidator(validatorOptions)
    const msg = await createMockMessage(messageOptions)
    try {
        await validator.validate(msg)
    } finally {
        validator.stop()
    }
}

describe('Validator', () => {
    
    describe('StreamMessage', () => {

        it('happy path', async () => {
            await validate({})
        })

        it('invalid partition', async () => {
            await expect(() => validate({
                partition: PARTITION_COUNT
            })).rejects.toThrow(`Partition ${PARTITION_COUNT} is out of range`)
        })
    
        it('invalid signature', async () => {
            await expect(() => validate({
                signature: 'invalid-signature'
            })).rejects.toThrow('Signature validation failed')
        })

        it('invalid publisher', async () => {
            const otherWallet = Wallet.createRandom()
            await expect(() => validate({
                publisher: otherWallet.address,
                privateKey: otherWallet.privateKey
            })).rejects.toThrow('is not a publisher on stream streamId')
        })
    })
})
