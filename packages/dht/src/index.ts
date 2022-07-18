import { SimulatorTransport } from './connection/SimulatorTransport'
import { Simulator } from './connection/Simulator'
import { DhtNode } from './dht/DhtNode'
import { PeerID } from './helpers/PeerID'

const main = async () => {

    const mockDescriptor = {
        peerId: PeerID.fromString('jee').value,
        type: 0
    }
    const simulator = new Simulator()
    const mockConnectionLayer = new SimulatorTransport(mockDescriptor, simulator)
    
    new DhtNode({ peerIdString: 'peer', transportLayer: mockConnectionLayer })
}

main()
