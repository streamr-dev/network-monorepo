import { createSigners } from '../../src/utils/createSigners'
import { Claim, Receipt, toStreamID } from 'streamr-client-protocol'
import { SignatureFunctions } from 'streamr-network'
import { Authentication, createAuthentication } from '../../src/Authentication'

const SENDER_PK = '0xfbfb70ea3fc9a5ee125df648535175dc1fdd14443bf2b1fa9dd661253e06f77c'
const SENDER_ADDRESS = '0x8F19Eb1D0BF28c8aA28E5e50d81b7E59d5Aaa6eC'

const RECEIVER_PK = '0x55c9c8e62f18f16b0be13dda9b81177a2fef59bd47a1a747ee525c3fd21ce057'
const RECEIVER_ADDRESS = '0xccDd93065757e35CA932093d43c9d3D255ABEaa9'

const BASE_CLAIM: Readonly<Omit<Claim, 'signature' | 'sender' | 'receiver'>> = {
    streamId: toStreamID('stream'),
    streamPartition: 0,
    publisherId: '',
    msgChainId: '',
    windowNumber: 1,
    messageCount: 1,
    totalPayloadSize: 1
}

function initAutentication(privateKey: string | undefined): Authentication {
    return createAuthentication(privateKey === undefined ? {} : { privateKey }, {} as any)
}

describe(createSigners, () => {
    it('returns undefined if unauthenticated', () => {
        expect(createSigners(initAutentication(undefined))).toEqual(undefined)
    })

    describe.each(['without', 'with'])('nodeId %s sessionId', (setting) => {
        let unsignedClaim: Readonly<Omit<Claim, 'signature'>>
        let claimSigner: SignatureFunctions<Claim>
        let receiptSigner: SignatureFunctions<Receipt>

        beforeEach(() => {
            claimSigner = createSigners(initAutentication(SENDER_PK))!.claim
            receiptSigner = createSigners(initAutentication(RECEIVER_PK))!.receipt
            unsignedClaim = Object.freeze({
                ...BASE_CLAIM,
                sender: SENDER_ADDRESS + (setting === 'without' ? '' : '#sessionId12345'),
                receiver: RECEIVER_ADDRESS + (setting === 'without' ? '' : '#sessionId98765')
            })
        })

        describe('claims', () => {
            let signature: string

            beforeEach(async () => {
                signature = await claimSigner.sign(unsignedClaim)
            })

            it('claim can be signed', () => {
                expect(signature.length).toBeGreaterThan(30)
            })

            it('valid claim passes validation', () => {
                const valid = claimSigner.validate({
                    ...unsignedClaim,
                    signature
                })
                expect(valid).toEqual(true)
            })

            it('tampered claim signature fails validation', () => {
                const valid = claimSigner.validate({
                    ...unsignedClaim,
                    signature: signature + 'abba'
                })
                expect(valid).toEqual(false)
            })

            it('tampered claim sender fails validation', async () => {
                const valid = claimSigner.validate({
                    ...unsignedClaim,
                    sender: '0xE8CB59d02cd806b50A0C8f3Bf878Ed797E664Aeb',
                    signature
                })
                expect(valid).toEqual(false)
            })
        })

        describe('receipts', () => {
            let claim: Claim
            let signature: string

            beforeEach(async () => {
                claim = {
                    ...unsignedClaim,
                    signature: await claimSigner.sign(unsignedClaim)
                }
                signature = await receiptSigner.sign({ claim })
            })

            it('receipts can be signed', () => {
                expect(signature.length).toBeGreaterThan(30)
            })

            it('valid receipt passes validation', () => {
                const valid = receiptSigner.validate({
                    claim,
                    signature
                })
                expect(valid).toEqual(true)
            })

            it('tampered receipt signature fails validation', () => {
                const valid = receiptSigner.validate({
                    claim,
                    signature: signature + 'abba'
                })
                expect(valid).toEqual(false)
            })

            it('tampered claim receiver fails validation', () => {
                const valid = receiptSigner.validate({
                    claim: {
                        ...claim,
                        receiver: '0xd7800EC32De1308529deE609AD801D2D4BdC937E'
                    },
                    signature
                })
                expect(valid).toEqual(false)
            })

            it('tampered claim sender fails validation', () => {
                const valid = receiptSigner.validate({
                    claim: {
                        ...claim,
                        sender: '0xd7800EC32De1308529deE609AD801D2D4BdC937E'
                    },
                    signature
                })
                expect(valid).toEqual(false)
            })
        })
    })
})
