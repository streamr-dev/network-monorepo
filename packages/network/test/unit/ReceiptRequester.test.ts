import { ReceiptRequester } from '../../src/logic/receipts/ReceiptRequester'
import { Event } from '../../src/protocol/NodeToNode'
import { ReceiptStore } from '../../src/logic/receipts/ReceiptStore'
import { Signers } from '../../src/logic/receipts/SignatureFunctions'
import { EventEmitter } from 'events'
import {
    BroadcastMessage,
    ControlMessage, ControlMessageType,
    ErrorResponse,
    MessageID,
    StreamMessage,
    toStreamID
} from 'streamr-client-protocol'
import { NodeId } from '../../src/identifiers'
import { getWindowNumber, getWindowStartTime, WINDOW_LENGTH } from '../../src/logic/receipts/Bucket'
import { waitForCondition } from 'streamr-test-utils'

const UUID_REGEX = /[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}/

const ACTIVE_WINDOW = getWindowNumber(Date.now()) - 1

function sumOfPayloads(messages: Readonly<BroadcastMessage[]>): number {
    let sum = 0
    for (const { streamMessage } of messages) {
        sum += streamMessage.getSerializedContent().length
    }
    return sum
}

function createBroadcastMessage(streamId: string, str: string): BroadcastMessage {
    return new BroadcastMessage({
        requestId: '',
        streamMessage: new StreamMessage({
            messageId: new MessageID(
                toStreamID(streamId),
                10,
                getWindowStartTime(ACTIVE_WINDOW) + Math.floor(Math.random() * WINDOW_LENGTH),
                0,
                'publisherId',
                'msgChainId'
            ),
            content: {
                str
            }
        })
    })
}

describe(ReceiptRequester, () => {
    let receiptStore: ReceiptStore
    let signers: jest.Mocked<Signers>
    let fakeNodeToNode: EventEmitter & {
        send: jest.Mock<Promise<any>, [string, ControlMessage]>
        registerErrorHandler: jest.Mock<void, [string, (errorResponse: ErrorResponse, source: NodeId) => void]>
    }
    let requester: ReceiptRequester

    beforeEach(() => {
        receiptStore = new ReceiptStore('myNodeId')
        signers = {
            claim: {
                sign: jest.fn(),
                validate: jest.fn()
            },
            receipt: {
                sign: jest.fn(),
                validate: jest.fn()
            }
        }
        fakeNodeToNode = new class extends EventEmitter {
            send = jest.fn()
            registerErrorHandler = jest.fn()
        }
        requester = new ReceiptRequester({
            myNodeId: 'myNodeId',
            nodeToNode: fakeNodeToNode as any,
            receiptStore,
            signers,
            windowTimeoutMargin: 250,
            bucketUpdateTimeoutMargin: 250
        })
    })

    afterEach(() => {
        requester?.stop()
    })

    // TODO: test bucket closing timeout logic in more detail

    describe('receipt request sending', () => {
        describe('scenario: single counterparty', () => {
            let msgs: BroadcastMessage[]

            beforeEach(async () => {
                signers.claim.sign = jest.fn().mockResolvedValueOnce('a-signature')
                msgs = [
                    createBroadcastMessage('streamId', 'aaa'),
                    createBroadcastMessage('streamId', 'bbb'),
                    createBroadcastMessage('streamId', 'ccc')
                ]
                for (const msg of msgs) {
                    fakeNodeToNode.emit(Event.BROADCAST_MESSAGE_SENT, msg, 'otherNode')
                }
                await waitForCondition(() => fakeNodeToNode.send.mock.calls.length > 0)
            })

            it('error handler is registered', () => {
                expect(fakeNodeToNode.registerErrorHandler).toHaveBeenCalledTimes(1)
            })

            it('receipt request is sent', async () => {
                expect(fakeNodeToNode.send).toHaveBeenCalledTimes(1)
                expect(fakeNodeToNode.send).toHaveBeenCalledWith('otherNode', {
                    claim: {
                        messageCount: 3,
                        sender: 'myNodeId',
                        signature: 'a-signature',
                        receiver: 'otherNode',
                        streamId: 'streamId',
                        streamPartition: 10,
                        totalPayloadSize: sumOfPayloads(msgs),
                        msgChainId: 'msgChainId',
                        publisherId: 'publisherId',
                        windowNumber: ACTIVE_WINDOW
                    },
                    type: ControlMessageType.ReceiptRequest,
                    version: ControlMessage.LATEST_VERSION,
                    requestId: expect.stringMatching(UUID_REGEX)
                })
            })
        })

        describe('scenario: multiple counterparties, multiple streams', () => {
            beforeEach(async () => {
                signers.claim.sign = jest.fn().mockResolvedValueOnce('a-signature')
                const streamAMessages = [
                    createBroadcastMessage('stream-a', 'aaa'),
                    createBroadcastMessage('stream-a', 'bbb'),
                    createBroadcastMessage('stream-a', 'ccc'),
                    createBroadcastMessage('stream-a', 'ddd'),
                ]
                const streamBMessages = [
                    createBroadcastMessage('stream-b', 'eee'),
                    createBroadcastMessage('stream-b', 'fff'),
                    createBroadcastMessage('stream-b', 'ggg'),
                    createBroadcastMessage('stream-b', 'hhh'),
                ]
                const streamCMessages = [
                    createBroadcastMessage('stream-b', 'iii'),
                    createBroadcastMessage('stream-b', 'jjj'),
                    createBroadcastMessage('stream-b', 'kkk'),
                    createBroadcastMessage('stream-b', 'lll'),
                ]
                const streamDMessages = [
                    createBroadcastMessage('stream-b', 'mmm'),
                    createBroadcastMessage('stream-b', 'nnn'),
                ]

                const node1Messages = [...streamAMessages, ...streamBMessages.slice(1, 3)]
                const node2Messages = [...streamBMessages.slice(0, 3), ...streamCMessages]
                const node3Messages = [...streamDMessages]
                const node4Messages = [...streamAMessages.slice(2), ...streamBMessages, streamCMessages[3]]

                for (const msg of node1Messages) {
                    fakeNodeToNode.emit(Event.BROADCAST_MESSAGE_SENT, msg, 'node1')
                }

                for (const msg of node2Messages) {
                    fakeNodeToNode.emit(Event.BROADCAST_MESSAGE_SENT, msg, 'node2')
                }

                for (const msg of node3Messages) {
                    fakeNodeToNode.emit(Event.BROADCAST_MESSAGE_SENT, msg, 'node3')
                }

                for (const msg of node4Messages) {
                    fakeNodeToNode.emit(Event.BROADCAST_MESSAGE_SENT, msg, 'node4')
                }

                await waitForCondition(() => fakeNodeToNode.send.mock.calls.length > 0)
            })

            it('error handler is registered', () => {
                expect(fakeNodeToNode.registerErrorHandler).toHaveBeenCalledTimes(1)
            })

            it('receipt request is sent', async () => {
                expect(fakeNodeToNode.send).toHaveBeenCalledTimes(1)
                expect(fakeNodeToNode.send).toHaveBeenCalledWith('otherNode', {
                    claim: {
                        messageCount: 3,
                        sender: 'myNodeId',
                        signature: 'a-signature',
                        receiver: 'otherNode',
                        streamId: 'streamId',
                        streamPartition: 10,
                        totalPayloadSize: sumOfPayloads(msgs),
                        msgChainId: 'msgChainId',
                        publisherId: 'publisherId',
                        windowNumber: ACTIVE_WINDOW
                    },
                    type: ControlMessageType.ReceiptRequest,
                    version: ControlMessage.LATEST_VERSION,
                    requestId: expect.stringMatching(UUID_REGEX)
                })
            })
        })
    })
})
