import { StreamPartID, StreamPartIDUtils } from 'streamr-client-protocol'
import { Instruction, InstructionSender, SendInstructionFn } from '../../src/logic/InstructionSender'
import { MetricsContext } from 'streamr-network'

const MOCK_STREAM_PART_1 = StreamPartIDUtils.parse('stream-id#1')
const MOCK_STREAM_PART_2 = StreamPartIDUtils.parse('stream-id#2')
const STARTUP_TIME = 1234567890

const DEBOUNCE_WAIT = 100
const MAX_WAIT = 2000

let mockInstructionIdSuffix = 0

const createMockInstruction = (streamPartId: StreamPartID): Instruction => {
    mockInstructionIdSuffix += 1
    return {
        nodeId: `mock-node-id-${mockInstructionIdSuffix}`,
        streamPartId,
        newNeighbors: [],
        counterValue: 0,
        ackOnly: false
    }
}

describe('InstructionSender', () => {
    let send: jest.Mock<ReturnType<SendInstructionFn>, Parameters<SendInstructionFn>>
    let sender: InstructionSender

    beforeEach(() => {
        jest.useFakeTimers()
        jest.setSystemTime(STARTUP_TIME)
        send = jest.fn().mockResolvedValue(true)
        sender = new InstructionSender({
            debounceWait: DEBOUNCE_WAIT,
            maxWait: MAX_WAIT,
        }, send, undefined as any, new MetricsContext()) // TODO implement sendStatusAck
    })

    afterEach(() => {
        jest.runOnlyPendingTimers()
        jest.useRealTimers()
    })

    function assertSendsCalled(instructions: readonly Instruction[]): void {
        expect(send).toBeCalledTimes(instructions.length)
        for (let i = 0; i < instructions.length; ++i) {
            const { nodeId, streamPartId, newNeighbors, counterValue } = instructions[i]
            expect(send).toHaveBeenNthCalledWith(i + 1, nodeId, streamPartId, newNeighbors, counterValue)
        }
    }

    it('wait stabilization', () => {
        const instruction = createMockInstruction(MOCK_STREAM_PART_1)
        sender.addInstruction(instruction)
        expect(send).not.toBeCalled()
        jest.advanceTimersByTime(DEBOUNCE_WAIT)
        assertSendsCalled([instruction])
    })

    it('add within stabilization wait', () => {
        const instruction1 = createMockInstruction(MOCK_STREAM_PART_1)
        sender.addInstruction(instruction1)
        jest.advanceTimersByTime(DEBOUNCE_WAIT / 2)
        const instruction2 = createMockInstruction(MOCK_STREAM_PART_1)
        sender.addInstruction(instruction2)
        jest.advanceTimersByTime(DEBOUNCE_WAIT)
        assertSendsCalled([instruction1, instruction2])
    })

    it('add after stabilization wait', () => {
        const instruction1 = createMockInstruction(MOCK_STREAM_PART_1)
        sender.addInstruction(instruction1)
        jest.advanceTimersByTime(DEBOUNCE_WAIT)
        const instruction2 = createMockInstruction(MOCK_STREAM_PART_1)
        sender.addInstruction(instruction2)
        jest.advanceTimersByTime(DEBOUNCE_WAIT)
        assertSendsCalled([instruction1, instruction2])
    })

    it('max wait reached', () => {
        const expected: Instruction[] = []
        while ((Date.now() - STARTUP_TIME) < MAX_WAIT) {
            const instruction = createMockInstruction(MOCK_STREAM_PART_1)
            sender.addInstruction(instruction)
            expected.push(instruction)
            jest.advanceTimersByTime(DEBOUNCE_WAIT / 2)
        }
        assertSendsCalled(expected)
    })

    it('independent stream buffers', () => {
        const instruction1 = createMockInstruction(MOCK_STREAM_PART_1)
        sender.addInstruction(instruction1)
        jest.advanceTimersByTime(DEBOUNCE_WAIT / 2)
        const instruction2 = createMockInstruction(MOCK_STREAM_PART_2)
        sender.addInstruction(instruction2)
        jest.advanceTimersByTime(DEBOUNCE_WAIT)
        assertSendsCalled([instruction1, instruction2])
    })
})
