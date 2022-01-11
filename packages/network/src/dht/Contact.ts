import type { DhtNode } from './DhtNode'
export class Contact {	
    private static counter = 0;

    public id: Uint8Array = new Uint8Array()
    public vectorClock = 0
    public dhtNode: DhtNode | undefined

    constructor(id: Uint8Array, dhtNode?: DhtNode) {
        this.id = id
        this.vectorClock = Contact.counter++
        this.dhtNode = dhtNode
    }
}