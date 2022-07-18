import { PeerID, PeerIDKey } from "../helpers/PeerID"
import { Message, PeerDescriptor } from "../proto/DhtRpc"
import { SimulatorTransport } from "./SimulatorTransport"

export class Simulator {

    private connectionManagers: Map<PeerIDKey, SimulatorTransport> = new Map()
    
    private latenciesEnabled = false

    addConnectionManager(manager: SimulatorTransport): void {
        this.connectionManagers.set(PeerID.fromValue(manager.getPeerDescriptor().peerId).toMapKey(), manager)
    }

    send(sourceDescriptor: PeerDescriptor, targetDescriptor: PeerDescriptor, msg: Message): void {
        if (this.latenciesEnabled) {
            setTimeout(() => {
                this.connectionManagers.get(PeerID.fromValue(targetDescriptor.peerId).toMapKey())!.handleIncomingMessage(sourceDescriptor, msg)
            }
            , Math.random() * (250 - 5) + 5)
        } else {
            this.connectionManagers.get(PeerID.fromValue(targetDescriptor.peerId).toMapKey())!.handleIncomingMessage(sourceDescriptor, msg)
        }
    }

    enableLatencies(): void {
        this.latenciesEnabled = true
    }

}
