import { v4, parse, stringify } from 'uuid'

export class UUID {
    private buf: Uint8Array

    constructor(other?: (UUID | Uint8Array | string)) {
        if (!other) {
            this.buf = new Uint8Array(16)
            v4(null, this.buf)
        } else if (other.constructor === UUID) {
            this.buf = other.buf
        } else if (typeof other === 'string') {
            this.buf = new Uint8Array(parse(other))
        } else {
            this.buf = other as Uint8Array
        }
    }

    toString(): string {
        return stringify(this.buf)
    }

    get value(): Uint8Array {
        return this.buf
    }
}
