import ControlMessage from '../ControlMessage'

import ReceiptRequest from './ReceiptRequest'

import { Serializer } from '../../../Serializer'

const VERSION = 2

export default class ReceiptRequestSerializerV2 extends Serializer<ReceiptRequest> {
    toArray(receiptRequest: ReceiptRequest): any[] {
        return [
            VERSION,
            ControlMessage.TYPES.ReceiptRequest,
            receiptRequest.requestId,
            receiptRequest.claim
        ]
    }

    fromArray(arr: any[]): ReceiptRequest {
        const [
            version,
            type, // eslint-disable-line @typescript-eslint/no-unused-vars
            requestId,
            claim
        ] = arr

        return new ReceiptRequest({
            version,
            requestId,
            claim
        })
    }
}

ControlMessage.registerSerializer(VERSION, ControlMessage.TYPES.ReceiptRequest, new ReceiptRequestSerializerV2())
