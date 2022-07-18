/* eslint-disable no-console */
import { Simulator } from '../../src/connection/Simulator'
import { DhtNode } from '../../src/dht/DhtNode'
import { PeerDescriptor } from '../../src/proto/DhtRpc'
import { createMockConnectionDhtNode } from '../utils'
import { execSync } from 'child_process'
import fs from 'fs'

describe('Kademlia correctness', () => {
    let entryPoint: DhtNode
    let nodes: DhtNode[]
    let entrypointDescriptor: PeerDescriptor
    const simulator = new Simulator()
    const NUM_NODES = 1000

    const nodeIndicesById: Record<string, number> = {}

    if (!fs.existsSync('test/kademlia-simulation/data/nodeids.json')) {
        console.log('gound truth data does not exist yet, generating..')
        execSync("npm run prepare-dht-simulation")
    }

    const dhtIds: Array<{ type: string, data: Array<number> }> = JSON.parse(fs.readFileSync('test/kademlia-simulation/data/nodeids.json').toString())
    const groundTruth: Record<string, Array<{ name: string, distance: number, id: { type: string, data: Array<number> } }>>
        = JSON.parse(fs.readFileSync('test/kademlia-simulation/data/orderedneighbors.json').toString())

    beforeEach(async () => {

        nodes = []
        const entryPointId = '0'
        entryPoint = await createMockConnectionDhtNode(entryPointId, simulator, Uint8Array.from(dhtIds[0].data), 8)
        nodes.push(entryPoint)
        nodeIndicesById[entryPoint.getNodeId().toMapKey()] = 0
        entrypointDescriptor = {
            peerId: entryPoint.getNodeId().value,
            type: 0
        }

        for (let i = 1; i < NUM_NODES; i++) {
            const nodeId = `${i}`

            const node = await createMockConnectionDhtNode(nodeId, simulator, Uint8Array.from(dhtIds[i].data))
            nodeIndicesById[node.getNodeId().toMapKey()] = i
            nodes.push(node)
        }
    })

    afterEach(async () => {
        await Promise.all([
            entryPoint.stop(),
            ...nodes.map(async (node) => await node.stop())
        ])
    })

    it('Can find correct neighbors', async () => {
        await entryPoint.joinDht(entrypointDescriptor)

        await Promise.allSettled(
            nodes.map((node) => node.joinDht(entrypointDescriptor))
        )

        let minimumCorrectNeighbors = Number.MAX_SAFE_INTEGER
        let maxOutgoingRpcCalls = 0
        let sumCorrectNeighbors = 0
        let sumKbucketSize = 1
        let sumOutgoingRpcCalls = 0

        for (let i = nodes.length - 1; i >= 0; i--) {

            const outgoingCalls = nodes[i].getNumberOfOutgoingClosestPeersRequests()

            if (outgoingCalls > maxOutgoingRpcCalls) {
                maxOutgoingRpcCalls = outgoingCalls
            }

            sumOutgoingRpcCalls += outgoingCalls

            let groundTruthString = 'groundTruthNeighb: '
            // eslint-disable-next-line @typescript-eslint/prefer-for-of
            for (let j = 0; j < groundTruth[i + ''].length; j++) {
                groundTruthString += groundTruth[i + ''][j].name + ','
            }

            const kademliaNeighbors = nodes[i].getNeighborList().getContactIds()

            let kadString = 'kademliaNeighbors: '
            kademliaNeighbors.forEach((neighbor) => {
                kadString += nodeIndicesById[neighbor.toMapKey()] + ','
            })

            let correctNeighbors = 0
            try {
                for (let j = 0; j < groundTruth[i + ''].length; j++) {
                    if (groundTruth[i + ''][j].name != (nodeIndicesById[kademliaNeighbors[j].toMapKey()] + '')) {
                        break
                    }
                    correctNeighbors++
                }
            } catch (e) {
                console.error("Node " + nodes[i].getNodeName() + " had only " + kademliaNeighbors.length + " kademlia neighbors")
            }
            if (correctNeighbors === 0) {
                console.log('No correct neighbors found for node ' + i)
                console.log(groundTruthString)
                console.log(kadString)
            }
            if (correctNeighbors < minimumCorrectNeighbors) {
                console.log("NEW MIN", i, correctNeighbors)
                minimumCorrectNeighbors = correctNeighbors
            }

            if (i > 0) {
                sumKbucketSize += nodes[i].getBucketSize()
                sumCorrectNeighbors += correctNeighbors
            }
        }

        const avgKbucketSize = sumKbucketSize / (NUM_NODES - 1)
        const avgCorrectNeighbors = sumCorrectNeighbors / (NUM_NODES - 1)
        const avgNumberOfOutgoingRpcCalls = sumOutgoingRpcCalls / (NUM_NODES - 1)

        console.log('----------- Simulation results ------------------')
        console.log('Minimum correct neighbors: ' + minimumCorrectNeighbors)
        console.log('Average correct neighbors: ' + avgCorrectNeighbors)
        console.log('Average Kbucket size: ' + avgKbucketSize)
        console.log('Average outgoing RPC calls: ' + avgNumberOfOutgoingRpcCalls)
        console.log('Max outgoing RPC calls: ' + maxOutgoingRpcCalls)
    })
})
