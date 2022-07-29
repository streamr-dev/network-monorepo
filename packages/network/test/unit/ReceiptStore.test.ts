import { ReceiptStore } from '../../src/logic/receipts/ReceiptStore'
import { Receipt, toStreamID } from 'streamr-client-protocol'

function createReceipt(sender: string, receiver: string): Receipt {
    return {
        claim: {
            streamId: toStreamID('stream'),
            streamPartition: 0,
            publisherId: '',
            msgChainId: '',
            windowNumber: 1,
            messageCount: 1,
            totalPayloadSize: 1,
            sender: sender,
            receiver: receiver,
            signature: ''
        },
        signature: ''
    }
}

describe(ReceiptStore, () => {
    let store: ReceiptStore

    beforeEach(() => {
        store = new ReceiptStore('myId')

        // 0xaaa <-> myId
        store.store(createReceipt('0xaaa', 'myId'))
        store.store(createReceipt('0xaaa', 'myId'))
        store.store(createReceipt('0xaaa', 'myId'))
        store.store(createReceipt('myId', '0xaaa'))

        // 0xbbb <-> myId
        store.store(createReceipt('myId', '0xbbb'))
        store.store(createReceipt('myId', '0xbbb'))

        // 0xccc <-> myId
        store.store(createReceipt('0xccc', 'myId'))
        store.store(createReceipt('0xccc', 'myId'))
    })

    it('getting receipt for non-existing node', () => {
        expect(store.getTheirReceipts('nonExistingNode')).toEqual([])
    })

    it('storing and getting receipts for a node', () => {
        expect(store.getTheirReceipts('0xaaa')).toHaveLength(3)
        expect(store.getTheirReceipts('0xbbb')).toHaveLength(0)
        expect(store.getTheirReceipts('0xccc')).toHaveLength(2)
    })

    it('will not store receipts for unrelated parties', () => {
        expect(() => store.store(createReceipt('0xaaa', '0xbbb')))
            .toThrowError('receipt between 0xaaa -> 0xbbb does not concern me (myId)')
    })
})
