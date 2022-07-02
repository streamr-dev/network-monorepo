import _ from 'lodash'
import { StreamPartID } from 'streamr-client-protocol'
import { Logger, NodeId, MetricsContext, MetricsDefinition, Metric, RateMetric } from 'streamr-network'
import { TopologyStabilizationOptions } from './Tracker'

/**
 * Instructions are collected to buffers and sent after a short delay. For each stream
 * part there is a separate buffer.
 *
 * We use debouncing to delay the sending. It means that we send the buffered instructions
 * when either of these conditions is satisfied:
 * - the topology stabilizes: no new instructions has been formed for the stream part
 *   in X milliseconds
 * - the buffer times out: we have buffered an instruction for Y milliseconds
 *
 * When an instruction is added to a the buffer, it may overwrite an existing
 * instruction in the buffer if the both instructions share the same nodeId. In that
 * situation we expect that the previous instruction is no longer valid (it has a lower
 * counterValue) and can be ignored.
 */

const DEFAULT_TOPOLOGY_STABILIZATION_OPTIONS: TopologyStabilizationOptions = {
    debounceWait: 100,
    maxWait: 2000
}

const logger = new Logger(module)

export interface Instruction {
    nodeId: NodeId
    streamPartId: StreamPartID
    newNeighbors: NodeId[]
    counterValue: number
    ackOnly: boolean
}

class StreamPartInstructionBuffer {
    private readonly instructions = new Map<NodeId, Instruction>()
    private readonly debouncedOnReady: _.DebouncedFunc<() => void>

    constructor(options: TopologyStabilizationOptions, onReady: () => void) {
        this.debouncedOnReady = _.debounce(onReady, options.debounceWait, {
            maxWait: options.maxWait
        })
    }

    addInstruction(instruction: Instruction) {
        // may overwrite an earlier instruction for the same node
        this.instructions.set(instruction.nodeId, instruction)
        this.debouncedOnReady()
    }

    getInstructions(): IterableIterator<Instruction> {
        return this.instructions.values()
    }

    stop(): void {
        this.debouncedOnReady.cancel()
    }
}

export type SendInstructionFn = (
    receiverNodeId: NodeId,
    streamPartId: StreamPartID,
    nodeIds: NodeId[],
    counter: number
) => Promise<void>

export type SendStatusAckFn = (
    receiverNodeId: NodeId,
    streamPartId: StreamPartID
) => Promise<void>

interface Metrics extends MetricsDefinition {
    instructionSent: Metric
}

export class InstructionSender {
    private readonly streamPartBuffers = new Map<StreamPartID, StreamPartInstructionBuffer>()
    private readonly options: TopologyStabilizationOptions
    private readonly sendInstruction: SendInstructionFn
    private readonly sendStatusAck: SendStatusAckFn
    private readonly metrics: Metrics

    constructor(
        options: TopologyStabilizationOptions | undefined,
        sendInstruction: SendInstructionFn,
        sendStatusAck: SendStatusAckFn,
        metricsContext: MetricsContext
    ) {
        this.options = options ?? DEFAULT_TOPOLOGY_STABILIZATION_OPTIONS
        this.sendInstruction = sendInstruction
        this.sendStatusAck = sendStatusAck
        this.metrics = {
            instructionSent: new RateMetric()
        }
        metricsContext.addMetrics('tracker', this.metrics)
    }

    addInstruction(instruction: Instruction): void {
        this.getOrCreateBuffer(instruction.streamPartId).addInstruction(instruction)
    }

    stop(): void {
        this.streamPartBuffers.forEach((entry) => entry.stop())
    }

    private getOrCreateBuffer(streamPartId: StreamPartID): StreamPartInstructionBuffer {
        const existingBuffer = this.streamPartBuffers.get(streamPartId)
        if (existingBuffer !== undefined) {
            return existingBuffer
        }
        const newBuffer = new StreamPartInstructionBuffer(this.options, () => {
            this.streamPartBuffers.get(streamPartId)?.stop()
            this.streamPartBuffers.delete(streamPartId)
            this.sendInstructions(newBuffer)
        })
        this.streamPartBuffers.set(streamPartId, newBuffer)
        return newBuffer

    }

    private async sendInstructions(buffer: StreamPartInstructionBuffer): Promise<void> {
        const promises = Array.from(buffer.getInstructions())
            .map(async ({ ackOnly, nodeId, streamPartId, newNeighbors, counterValue }) => {
                this.metrics.instructionSent.record(1)
                try {
                    if (ackOnly) {
                        await this.sendStatusAck(nodeId, streamPartId)
                        logger.debug('statusAck %s sent to node %s', streamPartId, nodeId)
                    } else {
                        await this.sendInstruction(nodeId, streamPartId, newNeighbors, counterValue)
                        logger.debug('instruction %o sent to node %o', newNeighbors, { counterValue, streamPartId, nodeId })
                    }
                } catch (err) {
                    logger.error('failed to send instructions / ack %o to node %o, reason: %s',
                        newNeighbors,
                        { counterValue, streamPartId, nodeId },
                        err)
                }
            })
        await Promise.allSettled(promises)
    }
}
