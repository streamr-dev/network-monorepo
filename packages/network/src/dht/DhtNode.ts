import KBucket from 'k-bucket'
import { Contact } from './Contact'
import { SortedContactList } from './SortedContactList'

export class DhtNode {

    private K = 8
    private ALPHA = 3

    private bucket: KBucket<Contact>
    private ownId: Uint8Array
    private ownContact: Contact

    private numberOfIncomingRpcCalls = 0
    private numberOfOutgoingRpcCalls = 0

    private neighborList: SortedContactList

    constructor(ownId: Uint8Array) {
        this.ownId = ownId
        this.ownContact = new Contact(this.ownId, this)
        this.bucket = new KBucket({
            localNodeId: this.ownId,
            numberOfNodesPerKBucket: this.K
        })

        this.neighborList = new SortedContactList(this.ownId, [])
    }

    // For simulation use

    public getNeightborList(): SortedContactList {
        return this.neighborList
    }
    public getContact(): Contact {
        return this.ownContact
    }

    public getKBucketSize(): number {
        return this.bucket.count()
    }

    public getNumberOfIncomingRpcCalls(): number {
        return this.numberOfIncomingRpcCalls
    }

    public getNumberOfOutgoingRpcCalls(): number {
        return this.numberOfOutgoingRpcCalls
    }
    
    // RPC call

    public getClosestNodesTo(id: Uint8Array, caller: DhtNode): Contact[] {
        this.numberOfIncomingRpcCalls++
        const ret = this.bucket.closest(id)
        
        if (!this.bucket.get(id)) {
            const contact = new Contact(id, caller)
            this.bucket.add(contact)
            this.neighborList.addContact(contact)
        }
        
        return ret
    }

    private findMoreContacts(contactList: Contact[], shortlist: SortedContactList) {
        contactList.forEach( (contact) => {
            shortlist.setContacted(contact.id)
            shortlist.setActive(contact.id)
            this.numberOfOutgoingRpcCalls++
            const returnedContacts = contact.dhtNode!.getClosestNodesTo(this.ownId, this)
            shortlist.addContacts(returnedContacts)
            returnedContacts.forEach( (returnedContact) => {
                if (!this.bucket.get(returnedContact.id)) {
                    this.bucket.add(returnedContact)
                }
            })
        })
    }

    public joinDht(entryPoint: DhtNode): void {
        if (Buffer.compare(entryPoint.getContact().id, this.ownId) == 0) {
            return
        }

        this.bucket.add(entryPoint.getContact())
        const closest = this.bucket.closest(this.ownId, this.ALPHA)

        this.neighborList.addContacts(closest)

        while (true) {
            let oldClosestContactId = this.neighborList.getClosestContactId()
            let uncontacted = this.neighborList.getUncontactedContacts(this.ALPHA)
            if (uncontacted.length < 1)
                return

            this.findMoreContacts(uncontacted, this.neighborList)

            /*
            if (this.neighborList.getActiveContacts().length >= this.K) {
                return
            }
            */
            
            if (Buffer.compare(oldClosestContactId, this.neighborList.getClosestContactId()) == 0) {
                uncontacted = this.neighborList.getUncontactedContacts(this.K)
                if (uncontacted.length < 1)
                    return

                while (true) {
                    oldClosestContactId = this.neighborList.getClosestContactId()
                    this.findMoreContacts(uncontacted, this.neighborList)

                    if (this.neighborList.getActiveContacts().length >= this.K || 
                    Buffer.compare(oldClosestContactId, this.neighborList.getClosestContactId()) == 0) {
                        return
                    }
                    uncontacted = this.neighborList.getUncontactedContacts(this.ALPHA)
                    if (uncontacted.length < 1)
                        return
                }
            }
        }
    }
}