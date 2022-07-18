import { DuplicateDetector } from '../../src/dht/DuplicateDetector'

describe('Route Message With Mock Connections', () => {
    let detector: DuplicateDetector
    const maxLimit = 10
    beforeEach(async () => {
        detector = new DuplicateDetector(2 ** 15, 16, 5, maxLimit)
    })

    it('detects duplicates', async () => {
        detector.add('test')
        expect(detector.counter).toEqual(1)
        expect(detector.isMostLikelyDuplicate('test')).toEqual(true)
    })

    it('resets on resetLimit', () => {
        for (let i = 0; i < maxLimit; i++) {
            detector.add(`test${i}`)
        }
        for (let i = 0; i < maxLimit; i++) {
            expect(detector.isMostLikelyDuplicate(`test${i}`)).toEqual(true)
        }
        detector.add('test10')
        expect(detector.counter).toEqual(1)
        expect(detector.isMostLikelyDuplicate('test1')).toEqual(false)
        expect(detector.isMostLikelyDuplicate('test6')).toEqual(true)
    })
})
