import fs from 'fs'
import crypto from 'crypto'
import { SortedContactList } from '../../../src/dht/SortedContactList'
import { Contact } from '../../../src/dht/Contact'
import KBucket from 'k-bucket'

const ID_LENGTH = 8
const NUM_NODES = 100

const generateId = function (): Uint8Array {
    return crypto.randomBytes(ID_LENGTH)
}

const writer = fs.createWriteStream('nodeids.json', {})
const neighborWriter = fs.createWriteStream('orderedneighbors.json', {})

const nodes: Array<Uint8Array> = []
const nodeNamesById: { [id: string]: number } = {} 

const neighbors: { [id: string]: Array<{name: number, distance: number, id: Uint8Array}> } = {}

for (let i=0; i<NUM_NODES; i++) {
    const id = generateId()
    nodeNamesById[JSON.stringify(id)] = i
    nodes.push(id)
}

for (let i=0; i<NUM_NODES; i++) {
    const list: SortedContactList = new SortedContactList(nodes[i], [])
    for (let j=0; j<NUM_NODES; j++) {
        if (i==j) {
            continue
        }
        list.addContact(new Contact(nodes[j]))
    }
    const neighborIds = list.getContactIds()
    const neighborNames: Array<{name: number, distance: number, id: Uint8Array}> = []
    neighborIds.forEach((id) => {
        neighborNames.push({name: nodeNamesById[JSON.stringify(id)], distance: KBucket.distance(nodes[i], id), id: id})
    })
    neighbors[i] = neighborNames
}

writer.write(JSON.stringify(nodes, null, 4))
writer.end()
neighborWriter.write(JSON.stringify(neighbors, null, 4))
neighborWriter.end()