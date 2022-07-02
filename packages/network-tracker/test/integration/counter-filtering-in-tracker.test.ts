import { Status, NodeId } from 'streamr-network/dist/src/identifiers'
import { runAndWaitForEvents, wait } from 'streamr-test-utils'
import { Tracker } from '../../src/logic/Tracker'
import { startTracker } from '../../src/startTracker'

import { NodeToTracker, NodeToTrackerEvent, PeerInfo, NodeClientWsEndpoint } from 'streamr-network'
import { Event as TrackerServerEvent } from '../../src/protocol/TrackerServer'
import { getTopology } from '../../src/logic/trackerSummaryUtils'
import { toStreamID } from 'streamr-client-protocol'

const WAIT_TIME = 2000

const formStatus = (counter: number, nodes: NodeId[]): Partial<Status> => ({
    streamPart: {
        id: toStreamID('stream-1'),
        partition: 0,
        neighbors: nodes,
        counter: counter
    }
})

describe('tracker: instruction counter filtering', () => {
    let tracker: Tracker
    let nodeToTracker1: NodeToTracker
    let nodeToTracker2: NodeToTracker

    beforeEach(async () => {
        tracker = await startTracker({
            listen: {
                hostname: '127.0.0.1',
                port: 30420
            }
        })
        const peerInfo1 = PeerInfo.newNode('nodeToTracker1')
        const peerInfo2 = PeerInfo.newNode('nodeToTracker2')
        const trackerPeerInfo = PeerInfo.newTracker(tracker.getTrackerId())
        const wsClient1 = new NodeClientWsEndpoint(peerInfo1)
        const wsClient2 = new NodeClientWsEndpoint(peerInfo2)
        nodeToTracker1 = new NodeToTracker(wsClient1)
        nodeToTracker2 = new NodeToTracker(wsClient2)

        await runAndWaitForEvents([
            () => { nodeToTracker1.connectToTracker(tracker.getUrl(), trackerPeerInfo) },
            () => { nodeToTracker2.connectToTracker(tracker.getUrl(), trackerPeerInfo) }
        ], [
            [nodeToTracker1, NodeToTrackerEvent.CONNECTED_TO_TRACKER],
            [nodeToTracker2, NodeToTrackerEvent.CONNECTED_TO_TRACKER]
        ])

        await runAndWaitForEvents([
            () => { nodeToTracker1.sendStatus(tracker.getTrackerId(), formStatus(0, []) as Status) },
        ], [
            [nodeToTracker1, NodeToTrackerEvent.STATUS_ACK_RECEIVED],
        ])

        await runAndWaitForEvents([
            () => { nodeToTracker2.sendStatus(tracker.getTrackerId(), formStatus(0, []) as Status) }
        ], [
            [nodeToTracker1, NodeToTrackerEvent.TRACKER_INSTRUCTION_RECEIVED],
            [nodeToTracker2, NodeToTrackerEvent.TRACKER_INSTRUCTION_RECEIVED]
        ])
    })

    afterEach(async () => {
        await nodeToTracker1.stop()
        await nodeToTracker2.stop()
        await tracker.stop()
    })

    test('handles status messages with counters equal or more to current counter(s)', async () => {
        await runAndWaitForEvents(
            () => {
                nodeToTracker1.sendStatus(tracker.getTrackerId(), formStatus(1, []) as Status)
                    .catch(() => {})
            },
            [nodeToTracker1, NodeToTrackerEvent.TRACKER_INSTRUCTION_RECEIVED],
            WAIT_TIME
        )
    })

    test('ignores status messages with counters less than current counter(s)', async () => {
        let numOfInstructions = 0
        nodeToTracker1.on(NodeToTrackerEvent.TRACKER_INSTRUCTION_RECEIVED, () => {
            numOfInstructions += 1
        })
        nodeToTracker1.sendStatus(tracker.getTrackerId(), formStatus(0, []) as Status)
            .catch(() => {})
        await wait(WAIT_TIME)
        expect(numOfInstructions).toEqual(0)
    })

    test('partly handles status messages with mixed counters compared to current counters', async () => {
        let numOfInstructions = 0
        nodeToTracker1.on(NodeToTrackerEvent.TRACKER_INSTRUCTION_RECEIVED, () => {
            numOfInstructions += 1
        })
        nodeToTracker1.sendStatus(tracker.getTrackerId(), formStatus(1, []) as Status)
            .catch(() => {})
        await wait(WAIT_TIME)
        expect(numOfInstructions).toEqual(1)
    })

    test('NET-36: tracker receiving status with old counter should not affect topology', async () => {
        const topologyBefore = getTopology(tracker.getOverlayPerStreamPart(), tracker.getOverlayConnectionRtts())
        await runAndWaitForEvents(
            () => { nodeToTracker1.sendStatus(tracker.getTrackerId(), formStatus(0, []) as Status) },
            // @ts-expect-error trackerServer is private
            [tracker.trackerServer, TrackerServerEvent.NODE_STATUS_RECEIVED]
        )
        expect(getTopology(tracker.getOverlayPerStreamPart(), tracker.getOverlayConnectionRtts())).toEqual(topologyBefore)
    })

    test('NET-36: tracker receiving status with partial old counter should not affect topology', async () => {
        const topologyBefore = getTopology(tracker.getOverlayPerStreamPart(), tracker.getOverlayConnectionRtts())
        await runAndWaitForEvents(
            () => {
                nodeToTracker1.sendStatus(tracker.getTrackerId(), formStatus(1, []) as Status)
            },
            // @ts-expect-error trackerServer is private
            [tracker.trackerServer, TrackerServerEvent.NODE_STATUS_RECEIVED]
        )
        expect(getTopology(tracker.getOverlayPerStreamPart(), tracker.getOverlayConnectionRtts())).toEqual(topologyBefore)
    })
})
