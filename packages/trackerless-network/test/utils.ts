import { Simulator, SimulatorTransport, PeerDescriptor, DhtNode } from '@streamr/dht'
import { RandomGraphNode } from '../src/logic/RandomGraphNode'

export const createMockRandomGraphNodeAndDhtNode = (
    ownPeerDescriptor: PeerDescriptor,
    entryPointDescriptor: PeerDescriptor,
    randomGraphId: string,
    simulator: Simulator
): [ DhtNode, RandomGraphNode ]  => {
    const mockCm = new SimulatorTransport(ownPeerDescriptor, simulator)
    const dhtNode = new DhtNode({
        transportLayer: mockCm,
        peerDescriptor: ownPeerDescriptor
    })

    const randomGraphNode = new RandomGraphNode({
        randomGraphId,
        P2PTransport: mockCm,
        layer1: dhtNode
    })
    simulator.addConnectionManager(mockCm)

    return [dhtNode, randomGraphNode]

}