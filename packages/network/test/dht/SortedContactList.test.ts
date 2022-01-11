import { SortedContactList } from '../../src/dht/SortedContactList'
import { DhtNode } from '../../src/dht/DhtNode'

describe('SortedContactList', () => {

    const id0 = Buffer.from([0,0,0,0])
    const id1 = Buffer.from([0,0,0,1])
    const id2 = Buffer.from([0,0,0,2])
    const id3 = Buffer.from([0,0,0,3])
    const id4 = Buffer.from([0,0,0,4])

    const node1 = new DhtNode(id1)
    const node2 = new DhtNode(id2)
    const node3 = new DhtNode(id3)

    it('compares Ids correctly', async () => {
        const list = new SortedContactList(id0, [])
        expect(list.compareIds(id0, id0)).toBe(0)
        expect(list.compareIds(id1, id1)).toBe(0)
        expect(list.compareIds(id0, id1)).toBe(-1)
        expect(list.compareIds(id0, id2)).toBe(-2)
        expect(list.compareIds(id1, id0)).toBe(1)
        expect(list.compareIds(id2, id0)).toBe(2)
        expect(list.compareIds(id2, id3)).toBe(-1)
        expect(list.compareIds(id1, id4)).toBe(-3)
    })

    it('orders itself correctly', async () => {
        
        const list = new SortedContactList(id0, [])
        
        list.setContact(node3.getContact())
        list.setContact(node2.getContact())
        list.setContact(node1.getContact())

        const contacts = list.getUncontactedContacts(3)
        expect(contacts).toHaveLength(3)
        expect(contacts[0]).toEqual(node1.getContact())
        expect(contacts[1]).toEqual(node2.getContact())
        expect(contacts[2]).toEqual(node3.getContact())
    })

    it('handles contacted nodes correctly', async () => {
        const list = new SortedContactList(id0, [])
        
        list.setContact(node3.getContact())
        list.setContact(node2.getContact())
        list.setContact(node1.getContact())

        list.setContacted(node2.getContact().id)
        const contacts = list.getUncontactedContacts(3)
        expect(contacts).toHaveLength(2)
        expect(contacts[0]).toEqual(node1.getContact())
        expect(contacts[1]).toEqual(node3.getContact())
    })
})
