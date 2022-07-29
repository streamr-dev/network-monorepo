import ControlMessage, { ControlMessageOptions } from '../ControlMessage'
import { validateIsString } from '../../../utils/validations'

export enum ErrorCode {
    AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
    NOT_FOUND = 'NOT_FOUND',

    // ReceiptRequest-related
    SENDER_IDENTITY_MISMATCH = 'SENDER_IDENTITY_MISMATCH', // TODO: should even send?
    INVALID_SIGNATURE = 'INVALID_SIGNATURE',
    CLAIM_DISAGREEMENT = 'CLAIM_DISAGREEMENT',
}

export interface Options extends ControlMessageOptions {
    errorMessage: string
    errorCode: ErrorCode
}

export default class ErrorResponse extends ControlMessage {

    errorMessage: string
    errorCode: ErrorCode

    constructor({ version = ControlMessage.LATEST_VERSION, requestId, errorMessage, errorCode }: Options) {
        super(version, ControlMessage.TYPES.ErrorResponse, requestId)

        validateIsString('errorMessage', errorMessage)
        this.errorMessage = errorMessage

        // Since V2
        if (version >= 2) {
            validateIsString('errorCode', errorCode)
        }
        this.errorCode = errorCode
    }
}
