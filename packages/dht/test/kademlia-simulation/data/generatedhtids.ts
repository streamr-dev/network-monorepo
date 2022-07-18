import fs from 'fs'
import crypto from 'crypto'
//import { SortedContactList } from '../../../src/simulation/SortedContactList'
//import { Contact } from '../../../src/simulation/Contact'
import KBucket from 'k-bucket'

const ID_LENGTH = 8
const NUM_NODES = 1000
const NUM_NEAREST = 10

const generateId = function(): Uint8Array {
    return crypto.randomBytes(ID_LENGTH)
}

const findNNearestNeighbors = function(ownIndex: number, ownId: Uint8Array, nodes: Array<Uint8Array>, n: number): Array<number> {
    const retIndex: Array<number> = []

    for (let i = 0; i < n; i++) {
        let closestIndex: number = Number.MAX_VALUE 
        let closestDistance: number = Number.MAX_VALUE
        
        for (let j = 0; j < nodes.length; j++) {
            if (j == ownIndex || retIndex.includes(j)) {
                continue
            }
            const distance = KBucket.distance(ownId, nodes[j])
            if (distance < closestDistance) {
                closestDistance = distance
                closestIndex = j
            }
        }
        retIndex.push(closestIndex)
    }
    return retIndex
}

const writer = fs.createWriteStream('nodeids.json', {})
const neighborWriter = fs.createWriteStream('orderedneighbors.json', {})

neighborWriter.write("{\n")

const nodes: Array<Uint8Array> = []
//const nodeNamesById: { [id: string]: number } = {} 

//const neighbors: { [id: string]: Array<{name: number, distance: number, id: Uint8Array}> } = {}

// generate nodeIds

for (let i = 0; i < NUM_NODES; i++) {
    const id = generateId()
    //nodeNamesById[JSON.stringify(id)] = i
    nodes.push(id)
}

writer.write(JSON.stringify(nodes, null, 4))
writer.end()

for (let i = 0; i < NUM_NODES; i++) {

    const neighborIds = findNNearestNeighbors(i, nodes[i], nodes, NUM_NEAREST)

    const neighborNames: Array<{ name: number, distance: number, id: Uint8Array }> = []
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let j = 0; j < neighborIds.length; j++) {
        neighborNames.push({ name: neighborIds[j], distance: KBucket.distance(nodes[i], nodes[neighborIds[j]]), id: nodes[neighborIds[j]] })
    }
    neighborWriter.write('"' + i + '": ' + JSON.stringify(neighborNames))
    process.stdout.write('.')

    if (i != NUM_NODES - 1) {
        neighborWriter.write(',\n')
    }
}

/*
for (let i=0; i<NUM_NODES; i++) {
    const list: SortedContactList = new SortedContactList(nodes[i], [])
   
    list.addContactsInBulk(nodes) 

    const neighborIds = list.getContactIds()
    const neighborNames: Array<{name: number, distance: number, id: Uint8Array}> = []
    for (let j=0; j < neighborIds.length && j < 20; j++) {
        neighborNames.push({name: nodeNamesById[JSON.stringify(neighborIds[j])], 
            distance: KBucket.distance(nodes[i], neighborIds[j]), id: neighborIds[j]})
    }
    neighbors[i] = neighborNames
    process.stdout.write('.')
}
*/

//neighborWriter.write(JSON.stringify(neighbors, null, 4))

neighborWriter.write("}")
neighborWriter.end()
