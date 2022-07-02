import { DhtNode, Simulator, SimulatorTransport, PeerDescriptor, PeerID } from '@streamr/dht'
import { RandomGraphNode } from '../../src/logic/RandomGraphNode'
import { range } from 'lodash'
import { waitForCondition } from 'streamr-test-utils'

describe('RandomGraphNode-DhtNode', () => {
    const numOfNodes = 128
    let dhtNodes: DhtNode[]
    let dhtEntryPoint: DhtNode
    let graphNodes: RandomGraphNode[]

    const streamId = 'Stream1'
    const entrypointDescriptor: PeerDescriptor = {
        peerId: PeerID.fromString('entrypoint').value,
        type: 0
    }

    const peerDescriptors: PeerDescriptor[] = range(numOfNodes).map((i) => {
        return {
            peerId: PeerID.fromString(`peer${i}`).value,
            type: 0
        }
    })
    beforeEach(async () => {
        const simulator = new Simulator()
        const entrypointCm = new SimulatorTransport(entrypointDescriptor, simulator)

        const cms: SimulatorTransport[] = range(numOfNodes).map((i) =>
            new SimulatorTransport(peerDescriptors[i], simulator)
        )

        dhtEntryPoint = new DhtNode({
            transportLayer: entrypointCm,
            peerDescriptor: entrypointDescriptor,
            appId: streamId
        })

        dhtNodes = range(numOfNodes).map((i) => new DhtNode({
            transportLayer: cms[i],
            peerDescriptor: peerDescriptors[i],
            appId: streamId
        }))

        graphNodes = range(numOfNodes).map((i) => new RandomGraphNode({
            randomGraphId: streamId,
            layer1: dhtNodes[i],
            P2PTransport: cms[i]
        }))

        await dhtEntryPoint.start()
        await dhtEntryPoint.joinDht(entrypointDescriptor)
        await Promise.all(dhtNodes.map((node) => node.start()))
    })

    afterEach(async () => {
        dhtEntryPoint.stop()
        await Promise.all(dhtNodes.map((node) => node.stop()))
        await Promise.all(graphNodes.map((node) => node.stop()))
    })

    it('happy path single peer', async () => {
        await dhtNodes[0].joinDht(entrypointDescriptor)
        await graphNodes[0].start()
        expect(graphNodes[0].getContactPoolIds().length).toEqual(1)
        expect(graphNodes[0].getSelectedNeighborIds().length).toEqual(1)
    })

    it('happy path 4 peers', async () => {
        range(4).map((i) => graphNodes[i].start())
        await Promise.all(range(4).map(async (i) => {
            await dhtNodes[i].joinDht(entrypointDescriptor)
        }))

        await waitForCondition(() => graphNodes[3].getSelectedNeighborIds().length >= 2)
        range(4).map((i) => {
            expect(graphNodes[i].getContactPoolIds().length).toBeGreaterThanOrEqual(2)
            expect(graphNodes[i].getSelectedNeighborIds().length).toBeGreaterThanOrEqual(2)
        })
    })

    it('happy path 128 peers', async () => {
        range(numOfNodes).map((i) => graphNodes[i].start())
        await Promise.all(range(numOfNodes).map(async (i) => {
            await dhtNodes[i].joinDht(entrypointDescriptor)
        }))
        await Promise.all(graphNodes.map((node) => {
            waitForCondition(() => node.getContactPoolIds().length >= 8),
            waitForCondition(() => node.getSelectedNeighborIds().length === 4)
        }))
    })
})