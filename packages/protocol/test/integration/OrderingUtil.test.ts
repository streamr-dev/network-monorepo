import { MessageID, OrderingUtil, toStreamID } from '../../src'
import shuffle from 'array-shuffle'
import StreamMessage from '../../src/protocol/message_layer/StreamMessage'
import MessageRef from '../../src/protocol/message_layer/MessageRef'
import { wait, waitForCondition } from 'streamr-test-utils'

const MESSAGES_PER_PUBLISHER = 1000
const NUM_OF_DUPLICATE_MESSAGES = 500
const MAX_GAP_FILL_MESSAGE_LATENCY = 20 // latency ~ [0, 20]
const GAP_FILLED_RATE = 1/10
const UNAVAILABLE_RATE = 1/100

const PROPAGATION_TIMEOUT = 200
const RESEND_TIMEOUT = 100
const MAX_GAP_REQUESTS = 5

const PUBLISHER_IDS = ['publisherOne', 'publisherTwo', 'publisherThree']

enum Delivery {
    REAL_TIME,
    GAP_FILL,
    UNAVAILABLE
}

interface MessageInfo {
    publisherId: string
    timestamp: number
    delivery: Delivery
}

function duplicateElements<T>(arr: readonly T[], numOfDuplicates: number): T[] {
    const newArr = Array.from(arr)
    for (let i = 0; i < numOfDuplicates; ++i) {
        newArr.push(arr[Math.floor(Math.random() * arr.length)])
    }
    return newArr
}

function intoChunks<T>(arr: readonly T[], chunkSize: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += chunkSize) {
        chunks.push(arr.slice(i, i + chunkSize))
    }
    return chunks
}

function formChainOfMessages(publisherId: string): Array<MessageInfo> {
    const chainOfMessages: MessageInfo[] = [{
        publisherId,
        timestamp: 1,
        delivery: Delivery.REAL_TIME
    }]
    for (let i = 2; i < MESSAGES_PER_PUBLISHER; i++) {
        chainOfMessages.push({
            publisherId,
            timestamp: i,
            delivery: Math.random() < UNAVAILABLE_RATE
                ? Delivery.UNAVAILABLE
                : (Math.random() < GAP_FILLED_RATE
                    ? Delivery.GAP_FILL
                    : Delivery.REAL_TIME
                )
        })
    }
    chainOfMessages.push({
        publisherId,
        timestamp: MESSAGES_PER_PUBLISHER,
        delivery: Delivery.REAL_TIME
    })
    return chainOfMessages
}

function createMsg({ publisherId, timestamp }: MessageInfo): StreamMessage {
    const messageId = new MessageID(toStreamID('streamId'), 0, timestamp, 0, publisherId, '')
    const prevMsgRef = timestamp > 1 ? new MessageRef(timestamp - 1, 0) : null
    return new StreamMessage({
        messageId,
        prevMsgRef,
        content: {},
    })
}

function calculateNumberOfUnfillableGaps(messageInfosInOrder: MessageInfo[]): number {
    let lastMessageUnavailable = false
    let gaps = 0
    messageInfosInOrder.forEach((messageInfo) => {
        if (!lastMessageUnavailable && messageInfo.delivery === Delivery.UNAVAILABLE) {
            lastMessageUnavailable = true
        } else if (lastMessageUnavailable && messageInfo.delivery !== Delivery.UNAVAILABLE) {
            gaps += 1
            lastMessageUnavailable = false
        }
    })
    return gaps
}

describe(OrderingUtil, () => {
    it('randomized "worst-case" scenario with unavailable messages and gap fill needs', async () => {
        const groundTruthMessages: Record<string, MessageInfo[]> = {}
        const actual: Record<string, number[]> = {}
        const expected: Record<string, number[]> = {}

        for (const publisherId of PUBLISHER_IDS) {
            groundTruthMessages[publisherId] = formChainOfMessages(publisherId)
            actual[publisherId] = []
            expected[publisherId] = groundTruthMessages[publisherId]
                .filter(({ delivery }) => delivery !== Delivery.UNAVAILABLE)
                .map(({ timestamp }) => timestamp)
        }

        const totalUnfillableGaps = PUBLISHER_IDS.reduce((sum, publisherId) => (
            sum + calculateNumberOfUnfillableGaps(groundTruthMessages[publisherId])
        ), 0)

        const inOrderHandler = (msg: StreamMessage) => {
            actual[msg.getPublisherId()].push(msg.getTimestamp())
        }

        const gapHandler = async (from: MessageRef, to: MessageRef, publisherId: string) => {
            const requestedMessages = groundTruthMessages[publisherId].filter(({ delivery, timestamp }) => {
                return delivery === Delivery.GAP_FILL && (timestamp > from.timestamp && timestamp <= to.timestamp)
            })
            for (const msgInfo of requestedMessages) {
                await wait(Math.random() * MAX_GAP_FILL_MESSAGE_LATENCY)
                util.add(createMsg(msgInfo))
            }
        }

        const errorHandler = jest.fn()
        const util = new OrderingUtil(inOrderHandler, gapHandler, PROPAGATION_TIMEOUT, RESEND_TIMEOUT, MAX_GAP_REQUESTS)
        util.on('error', errorHandler)

        // supply 1st message of chain always to set gap detection to work from 1st message onwards
        for (const publisherId of PUBLISHER_IDS) {
            util.add(createMsg(groundTruthMessages[publisherId][0]))
        }

        const realTimeMessages = Object.values(groundTruthMessages)
            .flat()
            .filter(({ delivery }) => delivery === Delivery.REAL_TIME)
        const shuffledWithDuplicates = duplicateElements(shuffle(realTimeMessages), NUM_OF_DUPLICATE_MESSAGES)

        const realTimeStart = Date.now()
        for (const chunkOfMsgInfos of intoChunks(shuffledWithDuplicates, 10)) {
            await wait(0)
            for (const msgInfo of chunkOfMsgInfos) {
                util.add(createMsg(msgInfo))
            }
        }
        const realTimeEnd = Date.now()
        const realTimeTook = realTimeEnd - realTimeStart
        const firstGapFillCouldFailAfter = PROPAGATION_TIMEOUT + RESEND_TIMEOUT * MAX_GAP_REQUESTS
        if (realTimeTook > firstGapFillCouldFailAfter) {
            // The time it takes to push all real-time messages should not exceed the time the first gap fill could fail
            // due to the message arriving later on...
            throw new Error(`took too long (${realTimeTook} ms > ${firstGapFillCouldFailAfter} ms) to ` +
            'push real-time messages, consider adding more timeout...')
        }

        await Promise.race([
            waitForCondition(() => PUBLISHER_IDS.every((publisherId) => (
                expected[publisherId].length === actual[publisherId].length
            )), 60*1000)
        ])
        expect(errorHandler).toHaveBeenCalledTimes(totalUnfillableGaps)
        expect(actual).toStrictEqual(expected)
    }, 120 * 1000)
})
