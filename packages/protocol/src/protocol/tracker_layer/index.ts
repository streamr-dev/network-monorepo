import InstructionMessage from "./instruction_message/InstructionMessage"
import ErrorMessage from "./error_message/ErrorMessage"
import RelayMessage, {
    RelayMessageSubType,
    RtcIceCandidateMessage,
    RtcConnectMessage,
    RtcOfferMessage,
    RtcAnswerMessage
} from "./relay_message/RelayMessage"
import StatusMessage from "./status_message/StatusMessage"
import StatusAckMessage from './status_ack_message/StatusAckMessage'
import TrackerMessage from "./TrackerMessage"
import { TrackerMessageType } from "./TrackerMessage"
import { Originator } from "./Originator"

// Serializers are imported because of their side effects: they statically register themselves to the factory class
import './error_message/ErrorMessageSerializerV2'
import './instruction_message/InstructionMessageSerializerV2'
import './relay_message/RelayMessageSerializerV2'
import './status_message/StatusMessageSerializerV2'
import './status_ack_message/StatusAckMessageSerializerV2'

export {
    InstructionMessage,
    ErrorMessage,
    StatusMessage,
    StatusAckMessage,
    TrackerMessage,
    TrackerMessageType,
    Originator,
    RelayMessage,
    RelayMessageSubType,
    RtcIceCandidateMessage,
    RtcConnectMessage,
    RtcOfferMessage,
    RtcAnswerMessage
}
