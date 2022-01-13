import { DhtNode } from './DhtNode'
import crypto from 'crypto'
import fs from 'fs'

export class DhtSimulation {
    
    private NUM_NODES = 100
    private ID_LENGTH = 8

    private nodeNamesById: { [id: string]: number } = {} 
    private nodes: DhtNode[]

    private dhtIds: Array<{type: string, data: Array<number>}>
    private groundTruth:  {[nodeName: string]: Array<{name: string, distance: number, id: {type: string, data: Array<number>}}>}

    constructor() {
        this.nodes = []
        if (!fs.existsSync('test/dht/data/nodeids.json')) {
            throw('Cannot find test/dht/data/nodeids.json, please run "npm run prepare-dht first"')
        }
        this.dhtIds = JSON.parse(fs.readFileSync('test/dht/data/nodeids.json').toString())
        this.groundTruth = JSON.parse(fs.readFileSync('test/dht/data/orderedneighbors.json').toString())
    }

    private generateId(): Uint8Array {
        return crypto.randomBytes(this.ID_LENGTH)
    }

    public run(): void {
        for (let i = 0; i < this.NUM_NODES; i++) {
            const node = new DhtNode(Buffer.from(this.dhtIds[i].data))
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
            
            let groundTruthString = 'groundTruthNeighb: '
            for (let j=0; j < this.groundTruth[i+''].length; j++) {
                groundTruthString += this.groundTruth[i+''][j].name + ','
            }
            // eslint-disable-next-line no-console
            console.log(groundTruthString)
            
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