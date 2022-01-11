import { DhtNode } from './DhtNode'
import crypto from 'crypto'

import dhtIds from '../../test/dht/data/nodeids.json'
//import orderedNeighbors from '../../test/dht/data/orderedneighbors.json'

export class DhtSimulation {
    
    private NUM_NODES = 1000
    private ID_LENGTH = 8

    private nodeNamesById: { [id: string]: number } = {} 
    private nodes: DhtNode[]

    constructor() {
        this.nodes = []
    }

    private generateId(): Uint8Array {
        return crypto.randomBytes(this.ID_LENGTH)
    }

    public run(): void {
        for (let i = 0; i < this.NUM_NODES; i++) {
            const node = new DhtNode(Buffer.from(dhtIds[i].data))
            this.nodeNamesById[JSON.stringify(node.getContact().id)] = i
            this.nodes.push(node)
            node.joinDht(this.nodes[0])
        }

        for (let i = this.nodes.length-1; i >= 0; i--) {
            // eslint-disable-next-line no-console
            console.log('-----------')
            console.log('Node: ' + i)
            console.log('Kbucket size: '+ this.nodes[i].getKBucketSize())
            console.log('Num incoming RPC calls: '+ this.nodes[i].getNumberOfIncomingRpcCalls())
            console.log('Num outgoing RPC calls: '+ this.nodes[i].getNumberOfOutgoingRpcCalls())
            
            /*
            let trueNeighbors = 'groundTruthNeighb: '
            for (let j=0; j < orderedNeighbors[i+''].length; j++) {
                trueNeighbors += orderedNeighbors[i+''][j].name
            }
            // eslint-disable-next-line no-console
            console.log(trueNeighbors)
            */
            const kademliaNeighbors = this.nodes[i].getNeightborList().getContactIds()
            let kadString = 'kademliaNeighbors: '
            kademliaNeighbors.forEach((neighbor) => {
                kadString += this.nodeNamesById[JSON.stringify(neighbor)] + ','
            })
            // eslint-disable-next-line no-console
            console.log(kadString)
        }
    }
}

const simulation = new DhtSimulation()
simulation.run()