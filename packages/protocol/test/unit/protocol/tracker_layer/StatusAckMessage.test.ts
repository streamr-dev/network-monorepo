import assert from 'assert'

import ValidationError from '../../../../src/errors/ValidationError'
import TrackerMessage from '../../../../src/protocol/tracker_layer/TrackerMessage'
import { toStreamID } from '../../../../src'
import StatusAckMessage from '../../../../src/protocol/tracker_layer/status_ack_message/StatusAckMessage'

describe('StatusAckMessage', () => {
    describe('constructor', () => {
        it('throws on null streamPartition', () => {
            assert.throws(() => new StatusAckMessage({
                requestId: 'requestId',
                streamId: toStreamID('streamId'),
                streamPartition: null as any
            }), ValidationError)
        })
        it('throws on null streamId', () => {
            assert.throws(() => new StatusAckMessage({
                requestId: 'requestId',
                streamId: null as any,
                streamPartition: 0
            }), ValidationError)
        })
        it('throws on null requestId', () => {
            assert.throws(() => new StatusAckMessage({
                requestId: null as any,
                streamId: toStreamID('streamId'),
                streamPartition: 0,
            }), ValidationError)
        })
        it('should create the latest version', () => {
            const msg = new StatusAckMessage({
                requestId: 'requestId',
                streamId: toStreamID('streamId'),
                streamPartition: 0
            })
            assert(msg instanceof StatusAckMessage)
            assert.strictEqual(msg.version, TrackerMessage.LATEST_VERSION)
            assert.strictEqual(msg.requestId, 'requestId')
            assert.strictEqual(msg.streamId, 'streamId')
            assert.strictEqual(msg.streamPartition, 0)
        })
    })
})
