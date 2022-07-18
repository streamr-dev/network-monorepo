import { NodeType, PeerDescriptor } from '../../src/proto/DhtRpc'
import { DhtNode } from '../../src/dht/DhtNode'
import { ConnectionManager } from '../../src/connection/ConnectionManager'

describe('WebSocket IConnection Requests', () => {
    const epPeerDescriptor: PeerDescriptor = {
        peerId: Uint8Array.from([1, 2, 3]),
        type: NodeType.NODEJS,
        websocket: { ip: 'localhost', port: 10021 }
    }
    let epDhtNode: DhtNode
    let node1: DhtNode
    let node2: DhtNode

    beforeEach(async () => {

        epDhtNode = new DhtNode({ peerDescriptor: epPeerDescriptor })
        await epDhtNode.start()

        await epDhtNode.joinDht(epPeerDescriptor)

        node1 = new DhtNode({ peerIdString: '1', webSocketPort: 10022, entryPoints: [epPeerDescriptor] })
        node2 = new DhtNode({ peerIdString: 'PeerWithoutServer', entryPoints: [epPeerDescriptor] })
        await node1.start()
        await node2.start()

        await epDhtNode.joinDht(epPeerDescriptor)
    })

    afterEach(async () => {
        await epDhtNode.stop()
        await node1.stop()
        await node2.stop()
    })

    it('Happy Path', async () => {
        await node2.joinDht(epPeerDescriptor)
        await node1.joinDht(epPeerDescriptor)

        expect((node1.getTransport() as ConnectionManager).hasConnection(node2.getPeerDescriptor())).toEqual(true)
        expect((node2.getTransport() as ConnectionManager).hasConnection(node1.getPeerDescriptor())).toEqual(true)

    }, 10000)
})
