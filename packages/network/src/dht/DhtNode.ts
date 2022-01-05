import KBucket from 'k-bucket'
import { Contact } from './Contact'
import { SortedContactList } from './SortedContactList'

export class DhtNode {

    private K = 20
    private ALPHA = 3

    private bucket: KBucket<Contact>
    private ownId: Uint8Array
    private ownContact: Contact

    constructor(ownId: Uint8Array) {
        this.ownId = ownId
        this.ownContact = new Contact(this.ownId, this)
        this.bucket = new KBucket({
            localNodeId: this.ownId
        })
    }

    // For simulation use

    public getContact(): Contact {
        return this.ownContact
    }

    public getKBucketSize(): number {
        return this.bucket.count()
    }
    
    // RPC call

    public getClosestNodesTo(id: Uint8Array, caller: DhtNode): Contact[] {
        if (!this.bucket.get(id)) {
            this.bucket.add(new Contact(id, caller))
        }
        return this.bucket.closest(id)
    }

    private findMoreContacts(contactList: Contact[], shortlist: SortedContactList) {
        contactList.forEach( (contact) => {
            shortlist.setContacted(contact.id)
            const returnedContacts = contact.dhtNode.getClosestNodesTo(this.ownId, this)
            shortlist.setContacts(returnedContacts)
            returnedContacts.forEach( (returnedContact) => {
                if (!this.bucket.get(returnedContact.id)) {
                    this.bucket.add(returnedContact)
                }
            })
        })
    }

    public joinDht(entryPoint: DhtNode): void {
        this.bucket.add(entryPoint.getContact())
        const shortlist = new SortedContactList(this.ownId, this.bucket.closest(this.ownId, this.ALPHA))

        while (true) {
            let oldClosestContactId = shortlist.getClosestContactId()
            let uncontacted = shortlist.getUncontactedContacts(this.ALPHA)

            this.findMoreContacts(uncontacted, shortlist)

            if (shortlist.getActiveContacts().length >= this.K) {
                return
            }

            else if (oldClosestContactId == shortlist.getClosestContactId()) {
                uncontacted = shortlist.getUncontactedContacts(this.K)

                while (true) {
                    oldClosestContactId = shortlist.getClosestContactId()
                    this.findMoreContacts(uncontacted, shortlist)

                    if (shortlist.getActiveContacts().length >= this.K || oldClosestContactId == shortlist.getClosestContactId()) {
                        return
                    }
                    uncontacted = shortlist.getUncontactedContacts(this.ALPHA)
                }
            }
        }
    }
}