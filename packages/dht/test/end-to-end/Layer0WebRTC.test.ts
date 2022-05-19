import { NodeType, PeerDescriptor } from '../../src/proto/DhtRpc'
import { DhtNode } from '../../src/dht/DhtNode'
import { PeerID } from '../../src/PeerID'

describe('Layer0 with WebRTC connections', () => {
    const epPeerDescriptor: PeerDescriptor = {
        peerId: PeerID.fromString('entrypoint').value,
        type: NodeType.NODEJS,
        websocket: { ip: 'localhost', port: 10029 }
    }
    let epDhtNode: DhtNode
    let node1: DhtNode
    let node2: DhtNode
    let node3: DhtNode
    let node4: DhtNode

    beforeEach(async () => {

        epDhtNode = new DhtNode({ peerDescriptor: epPeerDescriptor })
        await epDhtNode.start()

        await epDhtNode.joinDht(epPeerDescriptor)

        node1 = new DhtNode({peerIdString: 'Peer0', entryPoints: [epPeerDescriptor]})
        node2 = new DhtNode({peerIdString: 'Peer1', entryPoints: [epPeerDescriptor]})
        node3 = new DhtNode({peerIdString: 'Peer2', entryPoints: [epPeerDescriptor]})
        node4 = new DhtNode({peerIdString: 'Peer3', entryPoints: [epPeerDescriptor]})

        await node1.start()
        await node2.start()
        // await node3.start()
        // await node4.start()

        await epDhtNode.joinDht(epPeerDescriptor)
    })

    afterEach(async () => {
        await epDhtNode.stop()
        await node1.stop()
        await node2.stop()
        await node3.stop()
        await node4.stop()
    })

    it('Happy Path', async () => {
        await node1.joinDht(epPeerDescriptor)
        await node2.joinDht(epPeerDescriptor)
        // await node3.joinDht(epPeerDescriptor)
        // await node4.joinDht(epPeerDescriptor)

        expect(node1.getRpcCommunicator().getConnectionManager().hasConnection(node2.getPeerDescriptor())).toEqual(true)
        expect(node2.getRpcCommunicator().getConnectionManager().hasConnection(node1.getPeerDescriptor())).toEqual(true)

    }, 10000)
})