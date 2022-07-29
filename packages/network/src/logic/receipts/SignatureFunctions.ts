import { Claim, Receipt } from 'streamr-client-protocol'

export interface SignatureFunctions<T extends { signature: string }> {
    sign(item: Omit<T, 'signature'>): Promise<string>
    validate(item: T): boolean
}

export interface Signers {
    claim: SignatureFunctions<Claim>
    receipt: SignatureFunctions<Receipt>
}
