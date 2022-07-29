import {
    validateIsNotEmptyString,
    validateIsNotNullOrUndefined,
    validateIsOneOf,
} from '../../../utils/validations'
import TrackerMessage, { TrackerMessageOptions } from '../TrackerMessage'
import { Originator } from "../Originator"
import { Receipt } from '../../control_layer'

export enum RelayMessageSubType {
    RTC_OFFER = 'rtcOffer',
    RTC_ANSWER = 'rtcAnswer',
    RTC_CONNECT = 'rtcConnect',
    ICE_CANDIDATE = 'iceCandidate',
    INSPECT_REQUEST = 'inspectRequest',
    INSPECT_RESPONSE_PART = 'inspectResponsePart'
}

export interface RtcOfferMessage {
    subType: RelayMessageSubType.RTC_OFFER
    data: {
        connectionId: string
        description: string
    }
}

export interface RtcAnswerMessage {
    subType: RelayMessageSubType.RTC_ANSWER
    data: {
        connectionId: string
        description: string
    }
}

export interface RtcConnectMessage {
    subType: RelayMessageSubType.RTC_CONNECT
}

export interface RtcIceCandidateMessage {
    subType: RelayMessageSubType.ICE_CANDIDATE
    data: {
        connectionId: string
        candidate: string
        mid: string
    }
}

export interface InspectRequestMessage {
    subType: RelayMessageSubType.INSPECT_REQUEST
    data: {
        inspectionTarget: string
    }
}

export interface InspectResponsePartMessage {
    subType: RelayMessageSubType.INSPECT_RESPONSE_PART
    data: {
        receipt: Receipt
        done: false
    } | {
        done: true
    }
}

export interface SharedOptions extends TrackerMessageOptions {
    originator: Originator
    targetNode: string
    subType: RelayMessageSubType
    data: object
}

export type Options = SharedOptions & (
    RtcOfferMessage
    | RtcAnswerMessage
    | RtcConnectMessage
    | RtcIceCandidateMessage
    | InspectRequestMessage
    | InspectResponsePartMessage
)

export default class RelayMessage extends TrackerMessage {
    originator: Originator
    targetNode: string
    subType: RelayMessageSubType
    data: object

    constructor({ version = TrackerMessage.LATEST_VERSION, requestId, originator, targetNode, subType, data }: Options) {
        super(version, TrackerMessage.TYPES.RelayMessage, requestId)

        validateIsNotNullOrUndefined('originator', originator)
        validateIsNotEmptyString('targetNode', targetNode)
        validateIsOneOf('subType', subType, Object.values(RelayMessageSubType))
        validateIsNotNullOrUndefined('data', data)

        this.originator = originator
        this.targetNode = targetNode
        this.subType = subType
        this.data = data
    }

    isRtcOfferMessage(): this is RtcOfferMessage {
        return this.subType === RelayMessageSubType.RTC_OFFER
    }

    isRtcAnswerMessage(): this is RtcAnswerMessage {
        return this.subType === RelayMessageSubType.RTC_ANSWER
    }

    isRtcConnectMessage(): this is RtcConnectMessage {
        return this.subType === RelayMessageSubType.RTC_CONNECT
    }

    isIceCandidateMessage(): this is RtcIceCandidateMessage {
        return this.subType === RelayMessageSubType.ICE_CANDIDATE
    }

    isInspectRequestMessage(): this is InspectRequestMessage {
        return this.subType === RelayMessageSubType.INSPECT_REQUEST
    }

    isInspectResponsePartMessage(): this is InspectResponsePartMessage {
        return this.subType === RelayMessageSubType.INSPECT_RESPONSE_PART
    }

}
