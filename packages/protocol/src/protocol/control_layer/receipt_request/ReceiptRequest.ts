import {
    validateIsNotNullOrUndefined
} from '../../../utils/validations'
import ControlMessage, { ControlMessageOptions } from '../ControlMessage'
import { StreamID } from '../../../utils/StreamID'
import { EthereumAddress } from "../../../utils"

export interface Claim {
    streamId: StreamID
    streamPartition: number
    publisherId: string
    msgChainId: string
    windowNumber: number
    messageCount: number
    totalPayloadSize: number
    sender: EthereumAddress
    receiver: EthereumAddress
    signature: string
}

export interface Options extends ControlMessageOptions {
    claim: Claim
}

export default class ReceiptRequest extends ControlMessage {
    readonly claim: Claim

    constructor({ version = ControlMessage.LATEST_VERSION, requestId, claim }: Options) {
        super(version, ControlMessage.TYPES.ReceiptRequest, requestId)

        validateIsNotNullOrUndefined('claim', claim)

        this.claim = claim
    }
}
