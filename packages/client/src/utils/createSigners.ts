import { Signers } from 'streamr-network'
import { Claim, Receipt } from 'streamr-client-protocol'
import { verify } from './signingUtils'
import { getEthereumAddressFromNodeId } from './utils'
import { Authentication } from '../Authentication'

export function createSigners(authentication: Authentication): Signers | undefined {
    if (!authentication.isAuthenticated()) {
        return undefined
    }
    return {
        claim: {
            sign(claim: Omit<Claim, 'signature'>): Promise<string> {
                return authentication.createMessagePayloadSignature(JSON.stringify(claim))
            },
            validate({ signature, ...claim }: Claim): boolean {
                return verify(
                    getEthereumAddressFromNodeId(claim.sender),
                    JSON.stringify(claim),
                    signature
                )
            }
        },
        receipt: {
            sign(receipt: Omit<Receipt, 'signature'>): Promise<string> {
                return authentication.createMessagePayloadSignature(JSON.stringify(receipt))
            },
            validate({ signature, ...receipt }: Receipt): boolean {
                return verify(
                    getEthereumAddressFromNodeId(receipt.claim.receiver),
                    JSON.stringify(receipt),
                    signature
                )
            }
        }
    }
}
