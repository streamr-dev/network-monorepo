import { DhtNode } from './DhtNode'
import crypto from 'crypto'

export class DhtSimulation {
    
    private NUM_NODES = 10000
    private ID_LENGTH = 4

    private nodes: DhtNode[]

    constructor() {
        this.nodes = []
    }

    private generateId(): Uint8Array {
        return crypto.randomBytes(this.ID_LENGTH)
    }

    public run(): void {
        for (let i = 0; i < (this.NUM_NODES); i++) {
            const node = new DhtNode(this.generateId())
            this.nodes.push(node)
            node.joinDht(this.nodes[0])
        }

        for (let i = this.nodes.length-1; i >= 0; i--) {
            // eslint-disable-next-line no-console
            console.log(this.nodes[i].getKBucketSize() + ',' + this.nodes[i].getNumberOfIncomingRpcCalls())
        }
    }
}

const simulation = new DhtSimulation()
simulation.run()