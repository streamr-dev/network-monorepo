import { UUID } from '../../src/helpers/UUID'
import { v4 } from 'uuid'

describe('UUID', () => {

    it('generates unique IDs without constructor parameters', () => {
        const ids: UUID[] = []
        for (let i = 0; i < 100; i++) {
            ids.push(new UUID())
        }
        for (let x = 0; x < ids.length; x++) {
            const compare1 = ids[x]
            for (let y = 0; y < ids.length; y++) {
                if (x !== y) {
                    const compare2 = ids[y]
                    expect(compare1.toString() === compare2.toString()).toEqual(false)
                }
            }
        }
    })

    it('Uses passed string uuid parameter as id', () => {
        const stringId = v4()
        const uuid = new UUID(stringId)
        expect(uuid.toString() === stringId).toEqual(true)
    })

    it('Uses passed UUID as id', () => {
        const uuid1 = new UUID()
        const uuid2 = new UUID(uuid1)
        expect(uuid1.toString() === uuid2.toString()).toEqual(true)
    })

    it('Uses passed UintArray uuid as id', () => {
        const uuid1 = new UUID()
        const uuid2 = new UUID(uuid1.value)
        expect(uuid1.toString() === uuid2.toString()).toEqual(true)
    })

    it('Get value returns correct value', () => {
        const uuid1 = new UUID()
        const uuid2 = new UUID(uuid1.value)
        expect(Buffer.compare(uuid1.value, uuid2.value) === 0)
    })
})
