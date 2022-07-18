import KBucket from 'k-bucket'
import { PeerID, PeerIDKey } from '../helpers/PeerID'
import { DhtPeer } from './DhtPeer'

class ContactState {
    public contacted = false
    public active = false
    constructor(public contact: DhtPeer) {
    }
}

export class SortedContactList {
    private contactsById: Map<PeerIDKey, ContactState> = new Map()
    private contactIds: PeerID[] = []

    constructor(private ownId: PeerID, private maxSize: number) {
        this.compareIds = this.compareIds.bind(this)
        this.ownId = ownId
    }

    public getClosestContactId(): PeerID {
        return this.contactIds[0]
    }

    public getContactIds(): PeerID[] {
        return this.contactIds
    }

    public addContact(contact: DhtPeer): void {
        if (this.ownId.equals(contact.peerId)) {
            return
        }
        if (!this.contactsById.has(contact.peerId.toMapKey())) {
            if (this.contactIds.length < this.maxSize) {
                this.contactsById.set(contact.peerId.toMapKey(), new ContactState(contact))
                this.contactIds.push(contact.peerId)
                this.contactIds.sort(this.compareIds)
            
            } else if (this.compareIds(this.contactIds[this.maxSize - 1], contact.peerId) > 0) {
                const removed = this.contactIds.pop()
                this.contactsById.delete(removed!.toMapKey())
                this.contactsById.set(contact.peerId.toMapKey(), new ContactState(contact))
                this.contactIds.push(contact.peerId)
                this.contactIds.sort(this.compareIds)
            }
        }  
    }

    public addContacts(contacts: DhtPeer[]): void {
        contacts.forEach( (contact) => this.addContact(contact))
    }

    public setContacted(contactId: PeerID): void {
        if (this.contactsById.has(contactId.toMapKey())) {
            this.contactsById.get(contactId.toMapKey())!.contacted = true
        }
    }

    public setActive(contactId: PeerID): void {
        if (this.contactsById.has(contactId.toMapKey())) {
            this.contactsById.get(contactId.toMapKey())!.active = true
        }
    }

    public getUncontactedContacts(num: number): DhtPeer[] {
        const ret: DhtPeer[] = []
        for (const contactId of this.contactIds) {
            if (this.contactsById.has(contactId.toMapKey()) && !this.contactsById.get(contactId.toMapKey())!.contacted) {
                ret.push(this.contactsById.get(contactId.toMapKey())!.contact)
                if (ret.length >= num) {
                    return ret
                }
            }
        }
        return ret
    }

    public getActiveContacts(): DhtPeer[] {
        const ret: DhtPeer[] = []
        this.contactIds.forEach((contactId) => {
            if (this.isActive(contactId)) {
                ret.push(this.contactsById.get(contactId.toMapKey())!.contact)
            }
        })
        return ret
    }

    public compareIds(id1: PeerID, id2: PeerID): number {
        const distance1 = KBucket.distance(this.ownId.value, id1.value)
        const distance2 = KBucket.distance(this.ownId.value, id2.value)
        return distance1 - distance2
    }

    public getStringIds(): string[] {
        return this.contactIds.map((peerId) => peerId.toMapKey())
    }

    public getSize(): number {
        return this.contactIds.length
    }

    public getContact(id: PeerID): ContactState {
        return this.contactsById.get(id.toMapKey())!
    }

    public removeContact(id: PeerID): boolean {
        if (this.contactsById.has(id.toMapKey())) {
            const index = this.contactIds.indexOf(id)
            this.contactIds.splice(index, 1)
            this.contactsById.delete(id.toMapKey())
            return true
        }
        return false
    }

    public hasContact(id: PeerID): boolean {
        return this.contactsById.has(id.toMapKey())
    }

    public isActive(id: PeerID): boolean {
        return this.contactsById.has(id.toMapKey()) ? this.contactsById.get(id.toMapKey())!.active : false
    }

    public getAllContacts(): DhtPeer[] {
        return [...this.contactsById.values()].map((contact) => contact.contact)
    }

    public getMaxSize(): number {
        return this.maxSize
    }
}
