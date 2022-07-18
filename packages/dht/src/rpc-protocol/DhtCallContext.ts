import { CallContext } from "@streamr/proto-rpc"
import { PeerDescriptor } from "../proto/DhtRpc"
import { DhtRpcOptions } from "./DhtRpcOptions"

export class DhtCallContext extends CallContext implements DhtRpcOptions {
    // used by client
    targetDescriptor?: PeerDescriptor
    sourceDescriptor?: PeerDescriptor
    notification?: boolean
    clientId?: number

    //used in incoming calls
    incomingTargetDescriptor?: PeerDescriptor
    incomingSourceDescriptor?: PeerDescriptor
}
