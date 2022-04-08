// @generated by protobuf-ts 2.4.0 with parameter generate_dependencies,
// @generated from protobuf file "RouteMessage.proto" (syntax proto3),// tslint:disable
import { MessageType } from "@protobuf-ts/runtime"
import { Any } from "../../google/protobuf/any"
/**
 * @generated from protobuf message RouteMessage
 */
export interface RouteMessage {
    /**
     * @generated from protobuf field: string sourceId = 1;
     */
    sourceId: string
    /**
     * @generated from protobuf field: string nonce = 2;
     */
    nonce: string
    /**
     * @generated from protobuf field: string destinationId = 3;
     */
    destinationId: string
    /**
     * @generated from protobuf field: google.protobuf.Any message = 4;
     */
    message?: Any
    /**
     * @generated from protobuf field: string stunServer = 5;
     */
    stunServer: string // This shouldn't ever be needed if the servers are in the open internet
}
// @generated message type with reflection information, may provide speed optimized methods
class RouteMessage$Type extends MessageType<RouteMessage> {
    constructor() {
        super("RouteMessage", [
            { no: 1, name: "sourceId", kind: "scalar", T: 9 /*ScalarType.STRING*/ },
            { no: 2, name: "nonce", kind: "scalar", T: 9 /*ScalarType.STRING*/ },
            { no: 3, name: "destinationId", kind: "scalar", T: 9 /*ScalarType.STRING*/ },
            { no: 4, name: "message", kind: "message", T: () => Any },
            { no: 5, name: "stunServer", kind: "scalar", T: 9 /*ScalarType.STRING*/ }
        ])
    }
}
/**
 * @generated MessageType for protobuf message RouteMessage
 */
export const RouteMessage = new RouteMessage$Type()
