import { NodeType, PeerDescriptor } from '../../src/proto/DhtRpc'
import { DhtNode } from '../../src/dht/DhtNode'
import { PeerID } from '../../src/helpers/PeerID'

describe('Layer0-Layer1', () => {
    const epPeerDescriptor: PeerDescriptor = {
        peerId: Uint8Array.from([1, 2, 3]),
        type: NodeType.NODEJS,
        websocket: { ip: 'localhost', port: 10016 }
    }

    const STREAM_ID1 = 'stream1'
    const STREAM_ID2 = 'stream2'

    let epDhtNode: DhtNode
    let node1: DhtNode
    let node2: DhtNode

    let stream1Node1: DhtNode
    let stream1Node2: DhtNode
    let stream2Node1: DhtNode
    let stream2Node2: DhtNode

    beforeEach(async () => {

        epDhtNode = new DhtNode({ peerDescriptor: epPeerDescriptor })
        await epDhtNode.start()
        await epDhtNode.joinDht(epPeerDescriptor)

        node1 = new DhtNode({ peerIdString: '1', webSocketPort: 10017, entryPoints: [epPeerDescriptor] })
        node2 = new DhtNode({ peerIdString: '2', webSocketPort: 10018, entryPoints: [epPeerDescriptor] })

        await node1.start()
        await node2.start()

        stream1Node1 = new DhtNode({ transportLayer: epDhtNode, appId: STREAM_ID1 })
        stream1Node2 = new DhtNode({ transportLayer: node1, appId: STREAM_ID1 })

        stream2Node1 = new DhtNode({ transportLayer: epDhtNode, appId: STREAM_ID2 })
        stream2Node2 = new DhtNode({ transportLayer: node2, appId: STREAM_ID2 })

        await Promise.all([
            stream1Node1.start(),
            stream1Node2.start(),
            stream2Node1.start(),
            stream2Node2.start()
        ])

    })

    afterEach(async () => {
        await Promise.all([
            node1.stop(),
            node2.stop(),
            epDhtNode.stop(),
            stream1Node1.stop(),
            stream1Node2.stop(),
            stream2Node1.stop(),
            stream2Node2.stop()
        ])
    })

    it('Happy path', async () => {
        await Promise.all([
            node1.joinDht(epPeerDescriptor),
            node2.joinDht(epPeerDescriptor)
        ])
        await Promise.all([
            stream1Node1.joinDht(epPeerDescriptor),
            stream1Node2.joinDht(epPeerDescriptor)
        ])
        
        await Promise.all([
            stream2Node1.joinDht(epPeerDescriptor),
            stream2Node2.joinDht(epPeerDescriptor)
        ])
        expect(stream1Node1.getNeighborList().getSize()).toEqual(1)
        expect(stream1Node2.getNeighborList().getSize()).toEqual(1)
        expect(stream2Node1.getNeighborList().getSize()).toEqual(1)
        expect(stream2Node2.getNeighborList().getSize()).toEqual(1)

        expect(stream1Node1.getNeighborList().getContactIds()[0].equals(PeerID.fromValue(node1.getPeerDescriptor().peerId))).toEqual(true)
        expect(stream1Node2.getNeighborList().getContactIds()[0].equals(PeerID.fromValue(epPeerDescriptor.peerId))).toEqual(true)
        expect(stream2Node1.getNeighborList().getContactIds()[0].equals(PeerID.fromValue(node2.getPeerDescriptor().peerId))).toEqual(true)
        expect(stream2Node2.getNeighborList().getContactIds()[0].equals(PeerID.fromValue(epPeerDescriptor.peerId))).toEqual(true)
    })
})
