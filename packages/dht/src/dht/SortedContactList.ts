import KBucket from 'k-bucket'
import { PeerID } from '../helpers/PeerID'
import { DhtPeer } from './DhtPeer'

class ContactState {
    public contacted = false
    public active = false
    constructor(public contact: DhtPeer) {
    }
}

export class SortedContactList {
    private contactsById: { [id: string]: ContactState } = {}
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
        if (!this.contactsById.hasOwnProperty(contact.peerId.toMapKey())) {
            if (this.contactIds.length < this.maxSize) {
                this.contactsById[contact.peerId.toMapKey()] = new ContactState(contact)
                this.contactIds.push(contact.peerId)
                this.contactIds.sort(this.compareIds)
            
            } else if (this.compareIds(this.contactIds[this.maxSize - 1], contact.peerId) > 0) {
                const removed = this.contactIds.pop()
                delete this.contactsById[removed!.toMapKey()]
                this.contactsById[contact.peerId.toMapKey()] = new ContactState(contact)
                this.contactIds.push(contact.peerId)
                this.contactIds.sort(this.compareIds)
            }
        }  
    }

    public addContacts(contacts: DhtPeer[]): void {
        contacts.forEach( (contact) => this.addContact(contact))
    }

    public setContacted(contactId: PeerID): void {
        if (this.contactsById.hasOwnProperty(contactId.toMapKey())) {
            this.contactsById[contactId.toMapKey()].contacted = true
        }
    }

    public setActive(contactId: PeerID): void {
        if (this.contactsById.hasOwnProperty(contactId.toMapKey())) {
            this.contactsById[contactId.toMapKey()].active = true
        }
    }

    public getUncontactedContacts(num: number): DhtPeer[] {
        const ret: DhtPeer[] = []
        for (let i = 0; i < this.contactIds.length; i++) {
            const contactId = this.contactIds[i]
            if (this.contactsById[contactId.toMapKey()] && !this.contactsById[contactId.toMapKey()].contacted) {
                ret.push(this.contactsById[contactId.toMapKey()].contact)
                if (ret.length >= num) {
                    return ret
                }
            }
        }
        return ret
    }

    public getActiveContacts(limit = this.maxSize): DhtPeer[] {
        const ret: DhtPeer[] = []
        this.contactIds.forEach((contactId) => {
            if (this.isActive(contactId)) {
                ret.push(this.contactsById[contactId.toMapKey()].contact)
            }
        })
        return ret.splice(0, limit)
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
        return this.contactsById[id.toMapKey()]
    }

    public removeContact(id: PeerID): boolean {
        if (this.contactsById[id.toMapKey()]) {
            const index = this.contactIds.indexOf(id)
            this.contactIds.splice(index, 1)
            delete this.contactsById[id.toMapKey()]
            return true
        }
        return false
    }

    public hasContact(id: PeerID): boolean {
        return !!this.contactsById[id.toMapKey()]
    }

    public isActive(id: PeerID): boolean {
        return this.contactsById[id.toMapKey()] ? this.contactsById[id.toMapKey()].active : false
    }

    public getAllContacts(): DhtPeer[] {
        return Object.values(this.contactsById).map((contact) => contact.contact)
    }

    public getMaxSize(): number {
        return this.maxSize
    }
}
