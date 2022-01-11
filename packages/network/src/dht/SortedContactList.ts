import KBucket from 'k-bucket'
import { Contact } from './Contact'

class ContactWrapper {
    public contacted = false
    public active = false
    constructor(public contact: Contact) {
    }
}

export class SortedContactList {
    private ownId: Uint8Array
    private contactsById: { [id: string]: ContactWrapper } = {}
    private contactIds: Uint8Array[] = []

    constructor(ownId: Uint8Array,
        contacts: Contact[]) {

        this.compareIds = this.compareIds.bind(this)
        this.ownId = ownId
        contacts.forEach( (contact) => this.addContact(contact))
    }

    public getClosestContactId(): Uint8Array {
        return this.contactIds[0]
    }

    public getContactIds(): Uint8Array[] {
        return this.contactIds
    }

    public addContact(contact: Contact): void {
        if (Buffer.compare(contact.id, this.ownId) == 0) {
            return
        }
        if (!this.contactsById.hasOwnProperty(JSON.stringify(contact.id))) {
            this.contactsById[JSON.stringify(contact.id)] = new ContactWrapper(contact)
            this.contactIds.push(contact.id)
            this.contactIds.sort(this.compareIds)
        }
        
    }

    public addContacts(contacts: Contact[]): void {
        contacts.forEach( (contact) => this.addContact(contact))
    }

    public setContacted(contactId: Uint8Array): void {
        if (this.contactsById.hasOwnProperty(JSON.stringify(contactId))) {
            this.contactsById[JSON.stringify(contactId)].contacted = true
        }
    }

    public setActive(contactId: Uint8Array): void {
        if (this.contactsById.hasOwnProperty(JSON.stringify(contactId))) {
            this.contactsById[JSON.stringify(contactId)].active = true
        }
    }

    public getUncontactedContacts(num: number): Contact[] {
        const ret: Contact[] = []
        this.contactIds.forEach((contactId) => {
            if (!this.contactsById[JSON.stringify(contactId)].contacted) {
                ret.push(this.contactsById[JSON.stringify(contactId)].contact)
                if (ret.length >= num) {
                    return ret
                }
            }
        })
        return ret
    }

    public getActiveContacts(): Contact[] {
        const ret: Contact[] = []
        this.contactIds.forEach((contactId) => {
            if (!this.contactsById[JSON.stringify(contactId)].active) {
                ret.push(this.contactsById[JSON.stringify(contactId)].contact)
            }
        })
        return ret
    }

    public compareIds(id1: Uint8Array, id2: Uint8Array): number {
        const distance1 = KBucket.distance(this.ownId, id1)
        const distance2 = KBucket.distance(this.ownId, id2)
        return distance1 - distance2
    }

}