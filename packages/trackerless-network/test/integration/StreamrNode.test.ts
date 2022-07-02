import { DhtNode, SimulatorTransport, PeerDescriptor, PeerID, Simulator } from '@streamr/dht'
import { NodeType } from '@streamr/dht/dist/src/proto/DhtRpc'
import { waitForCondition, waitForEvent } from 'streamr-test-utils'
import { StreamrNode, Event as NodeEvent } from '../../src/logic/StreamrNode'
import { DataMessage, MessageRef } from '../../src/proto/NetworkRpc'

describe('StreamrNode', () => {

    let layer01: DhtNode
    let layer02: DhtNode
    let transport1: SimulatorTransport
    let transport2: SimulatorTransport
    let node1: StreamrNode
    let node2: StreamrNode

    const peer1: PeerDescriptor = {
        peerId: new Uint8Array([1,2,3]),
        type: NodeType.NODEJS
    }
    const peer2: PeerDescriptor = {
        peerId: new Uint8Array([1,1,1]),
        type: NodeType.NODEJS
    }
    const STREAM_ID = 'test'
    const messageRef: MessageRef = {
        sequenceNumber: 1,
        timestamp: 123123
    }
    const msg: DataMessage = {
        content: JSON.stringify({hello: "WORLD"}),
        senderId: PeerID.fromValue(peer2.peerId).toMapKey(),
        messageRef,
        streamPartId: STREAM_ID
    }
    afterEach(async () => {
        await Promise.all([
            layer01.stop(),
            layer02.stop(),
            node1.destroy(),
            node2.destroy()
        ])
    })

    beforeEach(async () => {
        const simulator = new Simulator()
        transport1 = new SimulatorTransport(peer1, simulator)
        transport2 = new SimulatorTransport(peer2, simulator)
        layer01 = new DhtNode({
            transportLayer: transport1,
            peerDescriptor: peer1
        })
        layer02 = new DhtNode({
            transportLayer: transport2,
            peerDescriptor: peer2
        })
        await Promise.all([
            layer01.start(),
            layer02.start()
        ])
        await Promise.all([
            layer01.joinDht(peer1),
            layer02.joinDht(peer1)
        ])

        node1 = new StreamrNode()
        node2 = new StreamrNode()
        await node1.start(layer01, transport1)
        await node2.start(layer02, transport2)
    })

    it('starts', async () => {
        expect(node1.getPeerDescriptor()).toEqual(peer1)
        expect(node2.getPeerDescriptor()).toEqual(peer2)
    })

    it('Joining stream', async () => {
        await node1.joinStream(STREAM_ID, peer1)
        await node2.joinStream(STREAM_ID, peer1)
        await waitForCondition(() => node1.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 1)
        await waitForCondition(() => node2.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 1)
        expect(node1.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length).toEqual(1)
        expect(node2.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length).toEqual(1)
    })

    it('Publishing after joining and waiting for neighbors', async () => {
        node1.subscribeToStream(STREAM_ID, peer1)
        await node2.joinStream(STREAM_ID, peer1)
        await waitForCondition(() => node1.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 1)
        await waitForCondition(() => node2.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 1)

        await Promise.all([
            waitForEvent(node1, NodeEvent.NEW_MESSAGE),
            node2.publishToStream(STREAM_ID, peer1, msg)
        ])
    })

    it('multi-stream pub/sub', async () => {
        const stream2 = 'test2'

        await node1.joinStream(STREAM_ID, peer1)
        await node1.joinStream(stream2, peer1)

        await node2.joinStream(STREAM_ID, peer1)
        await node2.joinStream(stream2, peer1)
        node1.subscribeToStream(STREAM_ID, peer1)
        node2.subscribeToStream(stream2, peer1)

        await Promise.all([
            waitForCondition(() => node1.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 1),
            waitForCondition(() => node2.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 1),
            waitForCondition(() => node1.getStream(stream2)!.layer2.getSelectedNeighborIds().length === 1),
            waitForCondition(() => node2.getStream(stream2)!.layer2.getSelectedNeighborIds().length === 1)
        ])

        const msg2: DataMessage = {
            content: JSON.stringify({hello: "WORLD"}),
            senderId: PeerID.fromValue(peer1.peerId).toMapKey(),
            messageRef,
            streamPartId: stream2
        }
        await Promise.all([
            waitForEvent(node1, NodeEvent.NEW_MESSAGE),
            waitForEvent(node2, NodeEvent.NEW_MESSAGE),
            node1.publishToStream(stream2, peer1, msg2),
            node2.publishToStream(STREAM_ID, peer1, msg)
        ])
    })

    it('leaving streams', async () => {
        await node1.joinStream(STREAM_ID, peer1)
        await node2.joinStream(STREAM_ID, peer1)
        await Promise.all([
            waitForCondition(() => node1.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 1),
            waitForCondition(() => node2.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 1)
        ])
        node2.leaveStream(STREAM_ID)
        await waitForCondition(() => node1.getStream(STREAM_ID)!.layer2.getSelectedNeighborIds().length === 0)
    })

    // TODO: make this work
    // it('Publishing and subscribing to streams without join awaits', async () => {
    //     node1.subscribeToStream(STREAM_ID, peer1)
    //     await Promise.all([
    //         waitForEvent(node1, NodeEvent.NEW_MESSAGE),
    //         node2.publishToStream(STREAM_ID, peer1, msg)
    //     ])
    // })

})