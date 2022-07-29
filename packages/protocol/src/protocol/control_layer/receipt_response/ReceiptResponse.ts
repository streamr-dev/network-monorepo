import { validateIsNotNullOrUndefined } from '../../../utils/validations'
import ControlMessage, { ControlMessageOptions } from '../ControlMessage'
import { Claim } from '../receipt_request/ReceiptRequest'

export interface Options extends ControlMessageOptions {
    receipt: Receipt
}

export interface Receipt {
    claim: Claim
    signature: string
}

export default class ReceiptResponse extends ControlMessage {
    readonly receipt: Receipt

    constructor({
        version = ControlMessage.LATEST_VERSION,
        requestId,
        receipt
    }: Options) {
        super(version, ControlMessage.TYPES.ReceiptResponse, requestId)
        validateIsNotNullOrUndefined('receipt', receipt) // TODO: proper validation of `Receipt`
        this.receipt = receipt
    }
}
