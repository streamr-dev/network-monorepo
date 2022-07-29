import { ResponseAwaiter } from '../../src/protocol/ResponseAwaiter'
import { ControlMessage, toStreamID, UnsubscribeRequest } from 'streamr-client-protocol'
import EventEmitter from 'events'
import { range } from 'lodash'

const PAYLOAD_BODY = {
    requestId: 'correctRequestId',
    streamId: toStreamID('streamId'),
    streamPartition: 0
} as const

describe(ResponseAwaiter, () => {
    let responseAwaiter: ResponseAwaiter<ControlMessage>
    let emitter: EventEmitter

    beforeEach(() => {
        emitter = new EventEmitter()
        responseAwaiter = new ResponseAwaiter<ControlMessage>(emitter, ['response'])
    })

    it('registered handler invoked when requestId matches', () => {
        const payload = new UnsubscribeRequest(PAYLOAD_BODY)
        const registeredFn = jest.fn().mockReturnValue(true)
        responseAwaiter.register('correctRequestId', registeredFn)
        emitter.emit('response', payload, 'source')
        expect(registeredFn).toHaveBeenCalledWith(payload, 'source')
    })

    it('registered handler not invoked when requestId does not match', () => {
        const payload = new UnsubscribeRequest({
            ...PAYLOAD_BODY,
            requestId: 'wrongRequestId'
        })
        const registeredFn = jest.fn().mockReturnValue(true)
        responseAwaiter.register('correctRequestId', registeredFn)
        emitter.emit('response', payload, 'source')
        expect(registeredFn).toHaveBeenCalledTimes(0)
    })

    it('registered handler not invoked when event does not match', () => {
        const payload = new UnsubscribeRequest(PAYLOAD_BODY)
        const registeredFn = jest.fn().mockReturnValue(true)
        responseAwaiter.register('correctRequestId', registeredFn)
        emitter.emit('unrecognizedEvent', payload, 'source')
        expect(registeredFn).toHaveBeenCalledTimes(0)
    })

    it('registered handler keeps getting invoked on each event until returns true', () => {
        const payload = new UnsubscribeRequest(PAYLOAD_BODY)
        const registeredFn = jest.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true)
        responseAwaiter.register('correctRequestId', registeredFn)
        // eslint-disable-next-line no-underscore-dangle
        for (const _idx of range(10)) {
            emitter.emit('response', payload, 'source')
        }
        expect(registeredFn).toHaveBeenCalledTimes(4)
    })
})
