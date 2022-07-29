import { NodeId } from '../../identifiers'
import { Receipt } from 'streamr-client-protocol'

function store(key: string, receipt: Receipt, map: Map<string, Receipt[]>): void {
    if (!map.has(key)) {
        map.set(key, [])
    }
    map.get(key)!.push(receipt)
}

export class ReceiptStore {
    private readonly myReceipts = new Map<NodeId, Receipt[]>()
    private readonly theirReceipts = new Map<NodeId, Receipt[]>()
    private readonly myId: NodeId

    constructor(myId: NodeId) {
        this.myId = myId
    }

    store(receipt: Receipt): void | never {
        const { sender, receiver } = receipt.claim
        if (sender === this.myId) {
            store(receiver, receipt, this.myReceipts)
        } else if (receiver === this.myId) {
            store(sender, receipt, this.theirReceipts)
        } else {
            throw new Error(`receipt between ${sender} -> ${receiver} does not concern me (${this.myId})`)
        }
    }

    getTheirReceipts(nodeId: NodeId): ReadonlyArray<Receipt> {
        return this.theirReceipts.get(nodeId) ?? []
    }
}
