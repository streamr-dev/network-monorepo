import ControlMessage from '../ControlMessage'

import ReceiptResponse from './ReceiptResponse'

import { Serializer } from '../../../Serializer'

const VERSION = 2

export default class ReceiptResponseSerializerV2 extends Serializer<ReceiptResponse> {
    toArray(receiptResponse: ReceiptResponse): any[] {
        return [
            VERSION,
            ControlMessage.TYPES.ReceiptResponse,
            receiptResponse.requestId,
            receiptResponse.receipt
        ]
    }

    fromArray(arr: any[]): ReceiptResponse {
        const [
            version,
            type, // eslint-disable-line @typescript-eslint/no-unused-vars
            requestId,
            receipt
        ] = arr

        return new ReceiptResponse({
            version,
            requestId,
            receipt
        })
    }
}

ControlMessage.registerSerializer(VERSION, ControlMessage.TYPES.ReceiptResponse, new ReceiptResponseSerializerV2())
