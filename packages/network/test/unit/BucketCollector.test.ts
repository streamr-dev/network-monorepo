import { BucketCollector } from '../../src/logic/receipts/BucketCollector'
import {
    MessageID,
    StreamMessage,
    StreamPartID,
    StreamPartIDUtils,
} from 'streamr-client-protocol'
import { BucketID, formBucketID, getWindowNumber, WINDOW_LENGTH } from '../../src/logic/receipts/Bucket'
import { NodeId } from '../../src/identifiers'

function makeBucketId(
    nodeId: NodeId,
    streamPartId: StreamPartID,
    publisherId: string,
    msgChainId: string,
    windowNumber: number
): BucketID {
    return formBucketID({
        nodeId,
        streamPartId,
        publisherId,
        msgChainId,
        windowNumber
    })
}

function makeMsg(
    streamPartId: StreamPartID,
    publisherId: string,
    msgChainId: string,
    timestamp: number,
    payloadSize: number
): StreamMessage {
    return new StreamMessage({
        messageId: new MessageID(
            StreamPartIDUtils.getStreamID(streamPartId),
            StreamPartIDUtils.getStreamPartition(streamPartId),
            timestamp,
            0,
            publisherId,
            msgChainId
        ),
        prevMsgRef: null,
        content: {
            'key': 'a'.repeat(payloadSize - 10) // 10 is size of structure without 'a's
        }
    })
}

const TIMESTAMP = 1652252050000
const WINDOW_NUMBER = getWindowNumber(TIMESTAMP)
const SP1 = StreamPartIDUtils.parse('stream-1#0')

describe(BucketCollector, () => {
    let collector: BucketCollector
    let testCaseStartTime: number

    beforeEach(() => {
        collector = new BucketCollector()
        testCaseStartTime = Date.now()
    })

    it('getting non-existing bucket', () => {
        expect(collector.getBucket('non-existing-bucket' as BucketID)).toBeUndefined()
    })

    it('recording some data and getting the bucket', () => {
        collector.record(makeMsg(SP1, 'publisherId', 'msgChainId', TIMESTAMP, 40), 'nodeId')
        collector.record(makeMsg(SP1, 'publisherId', 'msgChainId', TIMESTAMP + 15000, 160), 'nodeId')
        collector.record(makeMsg(SP1, 'publisherId', 'msgChainId', TIMESTAMP + 32000, 100), 'nodeId')
        const id = makeBucketId('nodeId', SP1, 'publisherId', 'msgChainId', WINDOW_NUMBER)
        expect(collector.getBucket(id)).toEqual({
            id,
            nodeId: 'nodeId',
            streamPartId: SP1,
            publisherId: 'publisherId',
            msgChainId: 'msgChainId',
            windowNumber: WINDOW_NUMBER,
            messageCount: 3,
            totalPayloadSize: 40 + 160 + 100,
            lastUpdate: expect.toBeWithin(testCaseStartTime, Date.now() + 1)
        })
    })

    it('recording some data spanning multiple buckets and getting the buckets', () => {
        const makeFixedMsg = (timestamp: number, payloadSize: number) => {
            return makeMsg(SP1, 'publisherId', 'msgChainId', timestamp, payloadSize)
        }
        collector.record(makeFixedMsg(TIMESTAMP, 40), 'nodeId')
        collector.record(makeFixedMsg(TIMESTAMP + (WINDOW_LENGTH / 2), 60), 'nodeId')

        collector.record(makeFixedMsg(TIMESTAMP + WINDOW_LENGTH, 100), 'nodeId')
        collector.record(makeFixedMsg(TIMESTAMP + WINDOW_LENGTH + 1000, 20), 'nodeId')

        collector.record(makeFixedMsg(TIMESTAMP + 2 * WINDOW_LENGTH + 2000, 15), 'nodeId')
        collector.record(makeFixedMsg(TIMESTAMP + 2 * WINDOW_LENGTH + WINDOW_LENGTH * (3 / 4), 20), 'nodeId')

        collector.record(makeFixedMsg(TIMESTAMP + 6 * WINDOW_LENGTH, 150), 'nodeId')

        const id1 = makeBucketId('nodeId', SP1, 'publisherId', 'msgChainId', WINDOW_NUMBER)
        const id2 = makeBucketId('nodeId', SP1, 'publisherId', 'msgChainId', WINDOW_NUMBER + 1)
        const id3 = makeBucketId('nodeId', SP1, 'publisherId', 'msgChainId', WINDOW_NUMBER + 2)
        const id4 = makeBucketId('nodeId', SP1, 'publisherId', 'msgChainId', WINDOW_NUMBER + 6)

        expect(collector.getBucket(id1)).toEqual(
            {
                id: id1,
                nodeId: 'nodeId',
                streamPartId: SP1,
                publisherId: 'publisherId',
                msgChainId: 'msgChainId',
                windowNumber: WINDOW_NUMBER,
                messageCount: 2,
                totalPayloadSize: 40 + 60,
                lastUpdate: expect.toBeWithin(testCaseStartTime, Date.now() + 1)
            })
        expect(collector.getBucket(id2)).toEqual({
            id: id2,
            nodeId: 'nodeId',
            streamPartId: SP1,
            publisherId: 'publisherId',
            msgChainId: 'msgChainId',
            windowNumber: WINDOW_NUMBER + 1,
            messageCount: 2,
            totalPayloadSize: 100 + 20,
            lastUpdate: expect.toBeWithin(testCaseStartTime, Date.now() + 1)
        })
        expect(collector.getBucket(id3)).toEqual({
            id: id3,
            nodeId: 'nodeId',
            streamPartId: SP1,
            publisherId: 'publisherId',
            msgChainId: 'msgChainId',
            windowNumber: WINDOW_NUMBER + 2,
            messageCount: 2,
            totalPayloadSize: 15 + 20,
            lastUpdate: expect.toBeWithin(testCaseStartTime, Date.now() + 1)
        })
        expect(collector.getBucket(id4)).toEqual({
            id: id4,
            nodeId: 'nodeId',
            streamPartId: SP1,
            publisherId: 'publisherId',
            msgChainId: 'msgChainId',
            windowNumber: WINDOW_NUMBER + 6,
            messageCount: 1,
            totalPayloadSize: 150,
            lastUpdate: expect.toBeWithin(testCaseStartTime, Date.now() + 1)
        })
    })

    it('removing a bucket', () => {
        collector.record(makeMsg(SP1, 'publisherId', 'msgChainId', TIMESTAMP, 40), 'nodeId')
        const id = makeBucketId('nodeId', SP1, 'publisherId', 'msgChainId', WINDOW_NUMBER)
        expect(collector.getBucket(id)).toBeDefined()
        collector.removeBucket(id)
        expect(collector.getBucket(id)).toBeUndefined()
    })
})
