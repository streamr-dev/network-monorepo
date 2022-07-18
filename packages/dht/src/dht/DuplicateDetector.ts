import { BloomFilter } from 'bloomfilter'

// Link for calculating false positive probabilities
// https://www.di-mgt.com.au/bloom-calculator.html
export class DuplicateDetector {
    currentFilter: BloomFilter
    nextFilter: BloomFilter | null
    counter: number

    // False positives at 0.05% at maximum capacity with default values
    constructor(
        private numOfBits = 2 ** 15,
        private numOfHashFunctions = 16,
        private nextFilterFillingLimit = 1050,
        private resetLimit = 2100
    ) {
        this.currentFilter = new BloomFilter(numOfBits, numOfHashFunctions)
        this.nextFilter = null
        this.counter = 0
    }

    add(value: string): void {
        if (this.nextFilter === null
            && this.counter >= this.nextFilterFillingLimit
            && this.counter < this.resetLimit
        ) {
            this.nextFilter = new BloomFilter(this.numOfBits, this.numOfHashFunctions)
        } else if (this.counter >= this.resetLimit) {
            this.counter = 0
            this.currentFilter = this.nextFilter!
            this.nextFilter = null
        }
        this.currentFilter.add(value)
        if (this.nextFilter) {
            this.nextFilter.add(value)
        }
        this.counter += 1
    }

    isMostLikelyDuplicate(value: string): boolean {
        return this.currentFilter.test(value)
    }

}

