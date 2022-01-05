import KBucket from 'k-bucket'
import { Contact } from './Contact'

class ContactWrapper {
    public contacted = false
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
        contacts.forEach( (contact) => this.setContact(contact))
    }

    public getClosestContactId(): Uint8Array {
        return this.contactIds[0]
    }

    public setContact(contact: Contact): void {
        if (!this.contactsById.hasOwnProperty(JSON.stringify(contact.id))) {
            this.contactIds.push(contact.id)
            this.contactIds.sort(this.compareIds)
        }
        this.contactsById[JSON.stringify(contact.id)] = new ContactWrapper(contact)
    }

    public setContacts(contacts: Contact[]): void {
        contacts.forEach( (contact) => this.setContact(contact))
    }

    public setContacted(contactId: Uint8Array): void {
        if (this.contactsById.hasOwnProperty(JSON.stringify(contactId))) {
            this.contactsById[JSON.stringify(contactId)].contacted = true
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
            ret.push(this.contactsById[JSON.stringify(contactId)].contact)
        })
        return ret
    }

    private compareIds(id1: Uint8Array, id2: Uint8Array): number {
        const distance1 = KBucket.distance(this.ownId, id1)
        const distance2 = KBucket.distance(this.ownId, id2)
        return distance1 - distance2
    }

}