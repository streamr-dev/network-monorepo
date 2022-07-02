/**
 * Represent a pair of numbers (a,b). Ordering between two pairs is defined as
 * follows. First compare first numbers. Compare second numbers if first are
 * equal.
 */
export class NumberPair {
    private readonly a
    private readonly b

    constructor(a: number, b: number) {
        this.a = a
        this.b = b
    }

    greaterThanOrEqual(otherPair: NumberPair): boolean {
        return this.greaterThan(otherPair) || this.equalTo(otherPair)
    }

    greaterThan(otherPair: NumberPair): boolean {
        return this.compareTo(otherPair) === 1
    }

    equalTo(otherPair: NumberPair): boolean {
        return this.compareTo(otherPair) === 0
    }

    private compareTo(otherPair: NumberPair): number {
        if (this.a > otherPair.a) {
            return 1
        }
        if (this.a < otherPair.a) {
            return -1
        }
        if (this.b > otherPair.b) {
            return 1
        }
        if (this.b < otherPair.b) {
            return -1
        }
        return 0
    }

    toString(): string {
        return `${this.a}|${this.b}`
    }
}

export class InvalidNumberingError extends Error {
    constructor() {
        super('pre-condition: previousNumber < number')
        // exclude this constructor from stack trace
        Error.captureStackTrace(this, InvalidNumberingError)
    }
}

export class GapMisMatchError extends Error {
    constructor(state: string, previousNumber: NumberPair, number: NumberPair) {
        super('pre-condition: gap overlap in given numbers:'
            + ` previousNumber=${previousNumber}, number=${number}, state=${state}`)
        Error.captureStackTrace(this, GapMisMatchError) // exclude this constructor from stack trace
    }
}

/**
 *
 * Keeps track of a stream's message numbers and reports already seen numbers
 * as duplicates.
 *
 * Leverages the fact that message are assigned numbers from a strictly
 * increasing integer sequence for lowered space complexity. For example,
 * if we know that all messages up to number N have been seen, we can only
 * store the number N to provide message identity check. This is because
 * anything less than N can be deemed a duplicate.
 *
 * Messages arriving out-of-order makes this a bit harder since gaps form.
 * Most of the code in this class is built to deal with this complexity.
 * Basically, we need to keep track of which intervals [N,M] could still
 * contain unseen messages. We should also remove intervals after we are sure
 * that they contain no unseen messages.
 *
 * In addition to the above, there needs to be a limit to the number of
 * intervals we store, as it could well be that some messages never
 * arrive. The strategy is to start removing the lowest numbered
 * intervals when storage limits are hit.
 *
 */
export class DuplicateMessageDetector {
    private readonly maxNumberOfGaps: number
    private readonly gaps: Array<[NumberPair, NumberPair]>

    constructor(maxNumberOfGaps = 10000) {
        this.maxNumberOfGaps = maxNumberOfGaps
        this.gaps = [] // ascending order of half-closed intervals (x,y] representing gaps that contain unseen message(s)
    }

    /**
     * returns true if number has not yet been seen (i.e. is not a duplicate)
     */
    markAndCheck(previousNumber: NumberPair | null, number: NumberPair): boolean | never {
        if (previousNumber && previousNumber.greaterThanOrEqual(number)) {
            throw new InvalidNumberingError()
        }

        if (this.gaps.length === 0) {
            this.gaps.push([number, new NumberPair(Infinity, Infinity)])
            return true
        }

        // Handle special case where previousNumber is not provided. Only
        // minimal duplicate detection is provided (comparing against latest
        // known message number).
        if (previousNumber === null) {
            if (number.greaterThan(this.gaps[this.gaps.length - 1][0])) {
                this.gaps[this.gaps.length - 1][0] = number
                return true
            }
            return false
        }

        for (let i = this.gaps.length - 1; i >= 0; --i) {
            const [lowerBound, upperBound] = this.gaps[i] // invariant: upperBound > lowerBound

            // implies number > upperBound (would've been handled in previous iteration if gap exists)
            if (previousNumber.greaterThanOrEqual(upperBound)) {
                return false
            }
            if (previousNumber.greaterThanOrEqual(lowerBound)) {
                if (number.greaterThan(upperBound)) {
                    throw new GapMisMatchError(this.toString(), previousNumber, number)
                }
                if (previousNumber.equalTo(lowerBound)) {
                    if (number.equalTo(upperBound)) {
                        this.gaps.splice(i, 1)
                    } else {
                        this.gaps[i] = [number, upperBound]
                    }
                } else if (number.equalTo(upperBound)) {
                    this.gaps[i] = [lowerBound, previousNumber]
                } else {
                    this.gaps.splice(i, 1, [lowerBound, previousNumber], [number, upperBound])
                }

                // invariants after:
                //   - gaps are in ascending order
                //   - the intersection between any two gaps is empty
                //   - there are no gaps that define the empty set
                //   - last gap is [n, Infinity]
                //   - anything not covered by a gap is considered seen

                this.dropLowestGapIfOverMaxNumberOfGaps()
                return true
            }
            if (number.greaterThan(lowerBound)) {
                throw new GapMisMatchError(this.toString(), previousNumber, number)
            }
        }
        return false
    }

    private dropLowestGapIfOverMaxNumberOfGaps(): void {
        // invariant: this.gaps.length <= this.maxNumberOfGaps + 1
        if (this.gaps.length > this.maxNumberOfGaps) {
            this.gaps.shift()
        }
    }

    toString(): string {
        return this.gaps.map(([lower, upper]) => `(${lower}, ${upper}]`).join(', ')
    }
}
