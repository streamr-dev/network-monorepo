import {
    Bucket,
    formBucketID,
    getBucketID,
    getWindowNumber,
    getWindowStartTime,
    WINDOW_LENGTH
} from '../../src/logic/receipts/Bucket'
import { MessageID, toStreamID, toStreamPartID } from 'streamr-client-protocol'
import { wait } from '@streamr/utils'

describe(getWindowNumber, () => {
    const TIMESTAMP = 1652252054325
    const WINDOW_NUMBER = getWindowNumber(TIMESTAMP)
    const WINDOW_LOWER_BOUND = getWindowStartTime(WINDOW_NUMBER)
    const WINDOW_UPPER_BOUND = getWindowStartTime(WINDOW_NUMBER + 1)

    it('timestamp lies within its window range', () => {
        expect(TIMESTAMP).toBeWithin(WINDOW_LOWER_BOUND, WINDOW_UPPER_BOUND)
    })

    it('window range is of expected length', () => {
        expect(WINDOW_UPPER_BOUND - WINDOW_LOWER_BOUND).toEqual(WINDOW_LENGTH)
    })

    it('WINDOW_LOWER_BOUND maps to current window (inclusive lower range)', () => {
        expect(getWindowNumber(WINDOW_LOWER_BOUND)).toEqual(WINDOW_NUMBER)
    })

    it('WINDOW_UPPER_BOUND maps to next window (exclusive upper range)', () => {
        expect(getWindowNumber(WINDOW_UPPER_BOUND)).toEqual(WINDOW_NUMBER + 1)
    })

    it('WINDOW_LOWER_BOUND - 1 maps to previous window', () => {
        expect(getWindowNumber(WINDOW_LOWER_BOUND - 1)).toEqual(WINDOW_NUMBER - 1)
    })

    it('WINDOW_UPPER_BOUND - 1 maps to current window', () => {
        expect(getWindowNumber(WINDOW_UPPER_BOUND - 1)).toEqual(WINDOW_NUMBER)
    })
})

describe(formBucketID, () => {
    it('forms expected bucketID', () => {
        const bucketId = formBucketID({
            nodeId: 'nodeId',
            streamPartId: toStreamPartID(toStreamID('stream'), 62),
            publisherId: 'publisher',
            msgChainId: 'xaxaxa',
            windowNumber: 31352
        })
        expect(bucketId).toEqual('nodeId_stream#62_publisher_xaxaxa_31352')
    })
})

const MESSAGE_ID = new MessageID(
    toStreamID('stream'),
    62,
    getWindowStartTime(31352),
    0,
    'publisher',
    'xaxaxa'
)

describe(getBucketID, () => {
    it('forms expected bucketID', () => {
        expect(getBucketID(MESSAGE_ID, 'nodeId')).toEqual(formBucketID({
            nodeId: 'nodeId',
            streamPartId: toStreamPartID(toStreamID('stream'), 62),
            publisherId: 'publisher',
            msgChainId: 'xaxaxa',
            windowNumber: 31352
        }))
    })
})

describe(Bucket, () => {
    it('creating and recording some data', () => {
        const bucket = new Bucket(MESSAGE_ID, 'nodeId')
        bucket.record(3154)
        bucket.record(6662)
        expect(bucket.getId()).toEqual(getBucketID(MESSAGE_ID, 'nodeId'))
        expect(bucket.getMessageCount()).toEqual(2)
        expect(bucket.getTotalPayloadSize()).toEqual(3154 + 6662)
    })

    it('recording data increments record count ', async () => {
        const bucket = new Bucket(MESSAGE_ID, 'nodeId')
        expect(bucket.getMessageCount()).toEqual(0)
        bucket.record(1234)
        expect(bucket.getMessageCount()).toEqual(1)
        bucket.record(1222)
        expect(bucket.getMessageCount()).toEqual(2)
    })

    it('recording data updates lastUpdate', async () => {
        const bucket = new Bucket(MESSAGE_ID, 'nodeId')
        const t1 = bucket.getLastUpdate()
        await wait(5)
        bucket.record(1234)
        const t2 = bucket.getLastUpdate()
        await wait(5)
        bucket.record(1222)
        const t3 = bucket.getLastUpdate()
        expect(t2).toBeGreaterThan(t1)
        expect(t3).toBeGreaterThan(t2)
    })
})
