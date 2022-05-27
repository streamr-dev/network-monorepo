import { wait, waitForCondition } from 'streamr-test-utils'
import { counterId } from '../../src/utils'
import { Context } from '../../src/utils/Context'
import { Debug, Msg, LeaksDetector } from '../test-utils/utils'
import { MessageStream, MessageStreamOnMessage, pullManyToOne } from '../../src/subscribe/MessageStream'
import { StreamMessage, MessageID, toStreamID, StreamID } from 'streamr-client-protocol'
import { Readable } from 'stream'

const MOCK_ERROR = new Error('mock-error-message')

const createMockMessage = (streamId: StreamID) => {
    return new StreamMessage({
        messageId: new MessageID(streamId, 0, 0, 0, 'publisherId', 'msgChainId'),
        content: Msg()
    })
}

const fromReadable = async (readable: Readable, context: Context, onMessage?: MessageStreamOnMessage<any>) => {
    const result = new MessageStream<any>(context)
    if (onMessage !== undefined) {
        result.useLegacyOnMessageHandler(onMessage)
    }
    result.pull((async function* readStream() {
        try {
            yield* readable
        } finally {
            readable.destroy()
        }
    }()))
    return result
}

const fromArray = async (arr: StreamMessage<any>[], context: Context, onMessage?: MessageStreamOnMessage<any>) => {
    return fromReadable(Readable.from(arr, { objectMode: true}), context, onMessage)
}

const waitForCalls = async (onMessage: jest.Mock<any>, n: number) => {
    await waitForCondition(() => onMessage.mock.calls.length >= n, 1000, 100, () => {
        return `Timeout while waiting for calls: got ${onMessage.mock.calls.length} out of ${n}`
    })
}

describe('MessageStream', () => {
    const streamId = toStreamID('streamId')
    let context: Context
    let leaksDetector: LeaksDetector

    beforeEach(async () => {
        leaksDetector = new LeaksDetector()
        const id = counterId('MessageStreamTest')
        context = {
            id,
            debug: Debug(id),
        }
    })

    afterEach(async () => {
        await leaksDetector.checkNoLeaks()
    })

    it('works', async () => {
        const s = new MessageStream(context)
        leaksDetector.add(s.id, s)
        const testMessage = Msg()
        leaksDetector.add('testMessage', testMessage)
        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        leaksDetector.add('streamMessage', streamMessage)
        s.push(streamMessage)
        const received = []
        for await (const msg of s) {
            leaksDetector.add('receivedMessage', msg)
            received.push(msg)
            break
        }

        expect(received).toEqual([streamMessage])
    })

    it('handles errors', async () => {
        const testMessage = Msg()
        const err = new Error(counterId('expected error'))
        leaksDetector.add('err', err)
        leaksDetector.add('testMessage', testMessage)
        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        leaksDetector.add('streamMessage', streamMessage)
        const s = new MessageStream<typeof testMessage>(context)
        leaksDetector.add(s.id, s)
        const received: StreamMessage<typeof testMessage>[] = []
        s.pull((async function* g() {
            yield streamMessage

            throw err
        }()))

        await expect(async () => {
            for await (const msg of s) {
                leaksDetector.add('receivedMessage', msg)
                received.push(msg)
            }
        }).rejects.toThrow(err)

        expect(received).toEqual([streamMessage])
    })

    it('handles immediate errors in pull', async () => {
        const testMessage = Msg()
        const err = new Error(counterId('expected error'))
        leaksDetector.add('err', err)
        leaksDetector.add('testMessage', testMessage)
        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        leaksDetector.add('streamMessage', streamMessage)
        const s = new MessageStream<typeof testMessage>(context)
        leaksDetector.add(s.id, s)
        const received: StreamMessage<typeof testMessage>[] = []
        s.onError.listen((error) => {
            throw error
        })
        // eslint-disable-next-line require-yield
        s.pull((async function* g() {
            throw err
        }()))

        await expect(async () => {
            for await (const msg of s) {
                leaksDetector.add('receivedMessage', msg)
                received.push(msg)
            }
        }).rejects.toThrow(err)

        expect(received).toEqual([])
    })

    it('handles error during iteration', async () => {
        const testMessage = Msg()
        leaksDetector.add('testMessage', testMessage)
        const s = new MessageStream<typeof testMessage>(context)
        leaksDetector.add(s.id, s)
        const err = new Error(counterId('expected error'))
        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        s.push(streamMessage)
        leaksDetector.add('streamMessage', streamMessage)
        const received: StreamMessage<typeof testMessage>[] = []
        await expect(async () => {
            for await (const msg of s) {
                leaksDetector.add('receivedMessage', msg)
                received.push(msg)
                throw err
            }
        }).rejects.toThrow(err)

        expect(received).toEqual([streamMessage])
    })

    it('emits errors', async () => {
        const testMessage = Msg()
        leaksDetector.add('testMessage', testMessage)
        const s = new MessageStream<typeof testMessage>(context)
        leaksDetector.add(s.id, s)
        const err = new Error(counterId('expected error'))
        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        leaksDetector.add('streamMessage', streamMessage)
        s.push(streamMessage)
        const received: StreamMessage<typeof testMessage>[] = []
        await expect(async () => {
            for await (const msg of s) {
                leaksDetector.add('receivedMessage', msg)
                received.push(msg)
                setTimeout(() => {
                    s.throw(err).catch(() => {})
                })
            }
        }).rejects.toThrow(err)
        await wait(10)

        expect(received).toEqual([streamMessage])
    })

    it('processes buffer before handling errors with endWrite', async () => {
        const testMessage = Msg()
        leaksDetector.add('testMessage', testMessage)
        const s = new MessageStream<typeof testMessage>(context)
        leaksDetector.add(s.id, s)
        const err = new Error(counterId('expected error'))

        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        leaksDetector.add('streamMessage', streamMessage)
        s.push(streamMessage)
        s.endWrite(err)
        const received: StreamMessage<typeof testMessage>[] = []
        await expect(async () => {
            for await (const msg of s) {
                leaksDetector.add('receivedMessage', msg)
                received.push(msg)
            }
        }).rejects.toThrow(err)

        expect(received).toEqual([streamMessage])
    })
    /*
    describe('when not started', () => {
        it('emits end with return', async () => {
            const testMessage = Msg()
            const s = new MessageStream<typeof testMessage>(context)
            const onEnd = jest.fn()
            s.on('end', onEnd)
            await s.return()

            expect(onEnd).toHaveBeenCalledTimes(1)
        })

        it('emits end with return', async () => {
            const testMessage = Msg()
            const s = new MessageStream<typeof testMessage>(context)

            const onEnd = jest.fn()
            s.on('end', onEnd)
            await s.return()

            expect(onEnd).toHaveBeenCalledTimes(1)
        })

        it('emits end + error with throw', async () => {
            const testMessage = Msg()
            const s = new MessageStream<typeof testMessage>(context)

            const onEnd = jest.fn()
            const onMessageStreamError = jest.fn()
            s.on('end', onEnd)
            s.on('error', onMessageStreamError)
            const err = new Error(counterId('expected error'))
            await expect(async () => {
                await s.throw(err)
            }).rejects.toThrow(err)

            expect(onEnd).toHaveBeenCalledTimes(1)
            expect(onMessageStreamError).toHaveBeenCalledTimes(1)
        })
    })
    */

    it('can collect', async () => {
        const testMessage = Msg()
        const s = new MessageStream<typeof testMessage>(context)

        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        s.push(streamMessage)
        const received = await s.collect(1)

        expect(received).toEqual([streamMessage])
    })

    it('can cancel collect with return', async () => {
        const testMessage = Msg()
        const s = new MessageStream<typeof testMessage>(context)
        leaksDetector.add('testMessage', testMessage)
        leaksDetector.add(s.id, s)

        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        leaksDetector.add('streamMessage', streamMessage)
        s.push(streamMessage)
        const collectTask = s.collect()
        await wait(10)
        await s.return()
        const received = await collectTask

        expect(received).toEqual([streamMessage])
    })

    it('can cancel collect with throw', async () => {
        const testMessage = Msg()
        const s = new MessageStream<typeof testMessage>(context)
        const err = new Error(counterId('expected error'))
        leaksDetector.add('testMessage', testMessage)
        leaksDetector.add(s.id, s)
        leaksDetector.add('err', err)

        const streamMessage = new StreamMessage({
            messageId: new MessageID(streamId, 0, 1, 0, 'publisherId', 'msgChainId'),
            content: testMessage,
        })
        leaksDetector.add('streamMessage', streamMessage)
        s.push(streamMessage)
        const collectTask = s.collect()
        await wait(10)
        await expect(async () => {
            await s.throw(err)
        }).rejects.toThrow(err)
        await expect(async () => {
            await collectTask
        }).rejects.toThrow(err)
    })

    describe('onMessage', () => {

        it('push', async () => {
            const stream = new MessageStream<any>(context)
            const onMessage = jest.fn()
            stream.useLegacyOnMessageHandler(onMessage)
            const msg = createMockMessage(streamId)
            stream.push(msg)
            await waitForCalls(onMessage, 1)
            expect(onMessage).toBeCalledTimes(1)
            expect(onMessage).toHaveBeenNthCalledWith(1, msg.getParsedContent(), msg)
        })
        
        it('from readable', async () => {
            const msg1 = createMockMessage(streamId)
            const msg2 = createMockMessage(streamId)
            const readable = Readable.from([msg1, msg2], { objectMode: true})
            const onMessage = jest.fn()
            fromReadable(readable, context, onMessage)
            await waitForCalls(onMessage, 2)
            expect(onMessage).toHaveBeenNthCalledWith(1, msg1.getParsedContent(), msg1)
            expect(onMessage).toHaveBeenNthCalledWith(2, msg2.getParsedContent(), msg2)
        })
    })

    describe('pullManyToOne', () => {
        it('push', async () => {
            const source1 = new MessageStream<any>(context)
            const source2 = new MessageStream<any>(context)
            const onMessage = jest.fn()
            pullManyToOne(context, [source1, source2], onMessage)
            const msg1 = createMockMessage(streamId)
            source1.push(msg1)
            const msg2 = createMockMessage(streamId)
            source2.push(msg2)
            await waitForCalls(onMessage, 2)
            expect(onMessage).toBeCalledTimes(2)
            expect(onMessage).toHaveBeenCalledWith(msg1.getParsedContent(), msg1)
            expect(onMessage).toHaveBeenCalledWith(msg2.getParsedContent(), msg2)
        })
        
        it('from readable with onMessage handler', async () => {
            const msgA1 = createMockMessage(streamId)
            const msgA2 = createMockMessage(streamId)
            const msgB1 = createMockMessage(streamId)
            const msgB2 = createMockMessage(streamId)
            const onMessage = jest.fn()
            const sourceA = await fromArray([msgA1, msgA2], context)
            const sourceB = await fromArray([msgB1, msgB2], context)
            pullManyToOne(context, [sourceA, sourceB], onMessage)
            await waitForCalls(onMessage, 4)
            expect(onMessage).toBeCalledTimes(4)
            expect(onMessage).toHaveBeenCalledWith(msgA1.getParsedContent(), msgA1)
            expect(onMessage).toHaveBeenCalledWith(msgA2.getParsedContent(), msgA2)
            expect(onMessage).toHaveBeenCalledWith(msgB1.getParsedContent(), msgB1)
            expect(onMessage).toHaveBeenCalledWith(msgB2.getParsedContent(), msgB2)
        })

        it('from readable without onMessage', async () => {
            const msgA1 = createMockMessage(streamId)
            const msgA2 = createMockMessage(streamId)
            const msgB1 = createMockMessage(streamId)
            const msgB2 = createMockMessage(streamId)
            const sourceA = await fromArray([msgA1, msgA2], context)
            const sourceB = await fromArray([msgB1, msgB2],  context)
            const merged = await pullManyToOne(context, [sourceA, sourceB])
            const received: any[] = []
            for await (const msg of merged) {
                received.push(msg)
            }
            expect(received).toIncludeSameMembers([msgA1, msgA2, msgB1, msgB2])
        })

        it('input error', async () => {
            const msgA1 = createMockMessage(streamId)
            const msgA2 = createMockMessage(streamId)
            const msgA3 = createMockMessage(streamId)
            const msgB1 = createMockMessage(streamId)
            const msgB2 = createMockMessage(streamId)
            const ERROR_INDEX = 1
            const sourceA = (await fromArray([msgA1, msgA2, msgA3], context)).map((value: StreamMessage<any>, index: number): StreamMessage<any> => {
                if (index === ERROR_INDEX) {
                    throw MOCK_ERROR
                } else {
                    return value
                }
            })
            const sourceB = await fromArray([msgB1, msgB2], context)
            const onError = jest.fn()
            const merged = await pullManyToOne(context, [sourceA, sourceB], undefined, onError)
            merged.onError.listen = onError
            const received: any[] = []
            for await (const msg of merged) {
                received.push(msg)
            }
            expect(received).toIncludeSameMembers([msgA1, msgA3, msgB1, msgB2])            
            expect(onError).toBeCalledWith(MOCK_ERROR)
        })
    })
})
