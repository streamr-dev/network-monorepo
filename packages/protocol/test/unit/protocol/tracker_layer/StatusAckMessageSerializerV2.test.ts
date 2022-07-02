import assert from 'assert'

import { toStreamID, TrackerLayer } from '../../../../src'
import TrackerMessage from '../../../../src/protocol/tracker_layer/TrackerMessage'

const { StatusAckMessage } = TrackerLayer

const VERSION = 2

// Message definitions
const message = new StatusAckMessage({
    version: VERSION,
    requestId: 'requestId',
    streamId: toStreamID('streamId'),
    streamPartition: 10
})
const serializedMessage = JSON.stringify([
    VERSION,
    TrackerMessage.TYPES.StatusAckMessage,
    'requestId',
    'streamId',
    10
])

describe('StatusAckMessageSerializerV2', () => {
    describe('deserialize', () => {
        it('correctly parses messages', () => {
            assert.deepStrictEqual(TrackerMessage.deserialize(serializedMessage), message)
        })
    })
    describe('serialize', () => {
        it('correctly serializes messages', () => {
            assert.deepStrictEqual(message.serialize(VERSION), serializedMessage)
        })
    })
})
