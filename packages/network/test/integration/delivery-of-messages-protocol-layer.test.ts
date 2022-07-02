import {
    ControlLayer,
    MessageLayer,
    RelayMessage,
    RelayMessageSubType,
    StreamPartIDUtils,
    toStreamID,
    TrackerLayer
} from 'streamr-client-protocol'
import { runAndWaitForEvents, waitForEvent } from 'streamr-test-utils'
import { startTracker, Tracker, TrackerServer, TrackerServerEvent } from '@streamr/network-tracker'
import { Event as NodeToNodeEvent, NodeToNode } from '../../src/protocol/NodeToNode'
import { Event as NodeToTrackerEvent, NodeToTracker } from '../../src/protocol/NodeToTracker'
import { PeerInfo } from '../../src/connection/PeerInfo'
import { RtcSignaller } from '../../src/logic/RtcSignaller'
import { NegotiatedProtocolVersions } from '../../src/connection/NegotiatedProtocolVersions'
import { MetricsContext } from '../../src/helpers/Metric'
import { WebRtcEndpoint } from '../../src/connection/webrtc/WebRtcEndpoint'
import { webRtcConnectionFactory } from '../../src/connection/webrtc/NodeWebRtcConnection'
import NodeClientWsEndpoint from '../../src/connection/ws/NodeClientWsEndpoint'
import { startServerWsEndpoint } from '../utils'

const { StreamMessage, MessageID, MessageRef } = MessageLayer

const UUID_REGEX = /[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}/

// eslint-disable-next-line no-underscore-dangle
declare let _streamr_electron_test: any

describe('delivery of messages in protocol layer', () => {
    let signallingTracker: Tracker | undefined
    let nodeToNode1: NodeToNode
    let nodeToNode2: NodeToNode
    let nodeToTracker: NodeToTracker
    let nodeToTracker2: NodeToTracker
    let trackerServer: TrackerServer

    beforeAll(async () => {
        signallingTracker = await startTracker({
            listen: {
                hostname: '127.0.0.1',
                port: 28515
            }
        })
        const peerInfo1 = PeerInfo.newNode('node1')
        const peerInfo2 = PeerInfo.newNode('node2')
        const trackerServerPeerInfo = PeerInfo.newTracker('trackerServer')
        const wsEndpoint1 = new NodeClientWsEndpoint(peerInfo1)
        const wsEndpoint2 = new NodeClientWsEndpoint(peerInfo2)
        const wsEndpoint3 = await startServerWsEndpoint('127.0.0.1', 28516, trackerServerPeerInfo)
        nodeToTracker = new NodeToTracker(wsEndpoint1)
        nodeToTracker2 = new NodeToTracker(wsEndpoint2)

        const wrtcEndpoint1 = new WebRtcEndpoint(
            peerInfo1,
            [],
            new RtcSignaller(peerInfo1, nodeToTracker),
            new MetricsContext(),
            new NegotiatedProtocolVersions(peerInfo1),
            webRtcConnectionFactory
        )
        const wrtcEndpoint2 =  new WebRtcEndpoint(
            peerInfo2,
            [],
            new RtcSignaller(peerInfo2, nodeToTracker2),
            new MetricsContext(),
            new NegotiatedProtocolVersions(peerInfo2),
            webRtcConnectionFactory
        )

        // @ts-expect-error: private field
        wrtcEndpoint1.rtcSignaller.setConnectListener(() => null)
        // @ts-expect-error: private field
        wrtcEndpoint2.rtcSignaller.setConnectListener(() => null)

        nodeToNode1 = new NodeToNode(wrtcEndpoint1)
        nodeToNode2 = new NodeToNode(wrtcEndpoint2)

        trackerServer = new TrackerServer(wsEndpoint3)

        // Connect nodeToTracker <-> trackerServer
        await nodeToTracker.connectToTracker(trackerServer.getUrl(), trackerServerPeerInfo)
        await nodeToTracker2.connectToTracker(trackerServer.getUrl(), trackerServerPeerInfo)

        // Connect nodeToTracker <-> Tracker (for signalling purposes)
        const signallingTrackerPeerInfo = PeerInfo.newTracker(signallingTracker.getTrackerId())
        await nodeToTracker.connectToTracker(signallingTracker.getUrl(), signallingTrackerPeerInfo)
        await nodeToTracker2.connectToTracker(signallingTracker.getUrl(), signallingTrackerPeerInfo)

        // Connect nodeToNode1 <-> nodeToNode2
        await runAndWaitForEvents(
            () => { nodeToNode1.connectToNode('node2', signallingTracker!.getTrackerId())}, [
                [nodeToNode2, NodeToNodeEvent.NODE_CONNECTED],
                [nodeToNode1, NodeToNodeEvent.NODE_CONNECTED]
            ])

        // signallingTracker was used to form webrtc connection, it is closed so it doesn't interfere with tests
        await signallingTracker?.stop()
        // eslint-disable-next-line require-atomic-updates
        signallingTracker = undefined
    }, 60000)

    afterAll(() => {
        return Promise.allSettled([
            nodeToNode2?.stop(),
            nodeToNode1?.stop(),
            nodeToTracker?.stop(),
            nodeToTracker2?.stop(),
            trackerServer?.stop(),
            signallingTracker?.stop()
        ])
    })

    it('sendData is delivered', async () => {
        const streamMessage = new StreamMessage({
            messageId: new MessageID(toStreamID('stream'), 10, 666, 0, 'publisherId', 'msgChainId'),
            prevMsgRef: new MessageRef(665, 0),
            content: {
                hello: 'world'
            },
            messageType: StreamMessage.MESSAGE_TYPES.MESSAGE,
            signatureType: StreamMessage.SIGNATURE_TYPES.ETH,
            signature: 'signature',
        })
        const messagePromise = waitForEvent(nodeToNode1, NodeToNodeEvent.DATA_RECEIVED)
        nodeToNode2.sendData('node1', streamMessage)
        const [msg, source]: any = await messagePromise

        expect(msg).toBeInstanceOf(ControlLayer.BroadcastMessage)
        expect(source).toEqual('node2')
        expect(msg.requestId).toEqual('')
        expect(msg.streamMessage.messageId).toEqual(new MessageID(toStreamID('stream'), 10, 666, 0, 'publisherId', 'msgChainId'))
        expect(msg.streamMessage.prevMsgRef).toEqual(new MessageRef(665, 0))
        expect(msg.streamMessage.getParsedContent()).toEqual({
            hello: 'world'
        })
        expect(msg.streamMessage.signatureType).toEqual(MessageLayer.StreamMessage.SIGNATURE_TYPES.ETH)
        expect(msg.streamMessage.signature).toEqual('signature')
    })

    it('sendInstruction is delivered', async () => {
        const messagePromise = waitForEvent(nodeToTracker, NodeToTrackerEvent.TRACKER_INSTRUCTION_RECEIVED)
        trackerServer.sendInstruction('node1', StreamPartIDUtils.parse('stream#10'), ['node1'], 15)
        const [msg, trackerId]: any = await messagePromise

        expect(trackerId).toEqual('trackerServer')
        expect(msg).toBeInstanceOf(TrackerLayer.InstructionMessage)
        expect(msg.requestId).toMatch(UUID_REGEX)
        expect(msg.streamId).toEqual('stream')
        expect(msg.streamPartition).toEqual(10)
        expect(msg.nodeIds).toEqual(['node1'])
        expect(msg.counter).toEqual(15)
    })

    it('sendStatusAck is delivered', async () => {
        const messagePromise = waitForEvent(nodeToTracker, NodeToTrackerEvent.STATUS_ACK_RECEIVED)
        trackerServer.sendStatusAck('node1', StreamPartIDUtils.parse('stream#10'))
        const [msg, trackerId]: any = await messagePromise

        expect(trackerId).toEqual('trackerServer')
        expect(msg).toBeInstanceOf(TrackerLayer.StatusAckMessage)
        expect(msg.requestId).toMatch(UUID_REGEX)
        expect(msg.streamId).toEqual('stream')
        expect(msg.streamPartition).toEqual(10)
    })

    it('sendStatus is delivered', async () => {
        const messagePromise = waitForEvent(trackerServer, TrackerServerEvent.NODE_STATUS_RECEIVED)
        nodeToTracker.sendStatus('trackerServer', {
            // @ts-expect-error missing fields
            status: 'status',
        })
        const [msg, source]: any = await messagePromise

        if (typeof _streamr_electron_test === 'undefined') {
            expect(msg).toBeInstanceOf(TrackerLayer.StatusMessage)
        }
        expect(source).toEqual('node1')
        expect(msg.requestId).toMatch(UUID_REGEX)
        expect(msg.status).toEqual({
            status: 'status'
        })
    })

    it('sendUnknownPeerError is delivered', async () => {
        const messagePromise = waitForEvent(nodeToTracker, NodeToTrackerEvent.RTC_ERROR_RECEIVED)
        trackerServer.sendUnknownPeerError('node1', 'requestId', 'unknownTargetNode')
        const [msg, source]: any = await messagePromise

        expect(msg).toBeInstanceOf(TrackerLayer.ErrorMessage)
        expect(source).toEqual('trackerServer')
        expect(msg.errorCode).toEqual(TrackerLayer.ErrorMessage.ERROR_CODES.UNKNOWN_PEER)
        expect(msg.targetNode).toEqual('unknownTargetNode')
    })

    it('sendData (rtcOffer) is delivered (trackerServer->nodeToTracker)', async () => {
        const messagePromise = waitForEvent(nodeToTracker, NodeToTrackerEvent.RELAY_MESSAGE_RECEIVED)
        const sentMessage = new RelayMessage({
            requestId: 'requestId',
            originator: PeerInfo.newNode('originatorNode'),
            targetNode: 'node1',
            subType: RelayMessageSubType.RTC_OFFER,
            data: {
                connectionId: 'connectionId',
                description: 'description'
            }

        })
        trackerServer.send('node1', sentMessage)
        
        const [msg, source] = await messagePromise

        expect(msg).toBeInstanceOf(TrackerLayer.RelayMessage)
        expect(source).toEqual('trackerServer')
        expect(msg).toEqual(sentMessage)
    })

    it('sendData (rtcAnswer) is delivered (trackerServer->nodeToTracker)', async () => {
        const messagePromise = waitForEvent(nodeToTracker, NodeToTrackerEvent.RELAY_MESSAGE_RECEIVED)
        const sentMessage = new RelayMessage({
            requestId: 'requestId',
            originator: PeerInfo.newNode('originatorNode'),
            targetNode: 'node1',
            subType: RelayMessageSubType.RTC_ANSWER,
            data: {
                connectionId: 'connectionId',
                description: 'description'
            }

        })
        trackerServer.send('node1', sentMessage)
        const [msg, source]: any = await messagePromise

        expect(msg).toBeInstanceOf(TrackerLayer.RelayMessage)
        expect(source).toEqual('trackerServer')
        expect(msg).toEqual(sentMessage)
    })

    it('sendData (rtcConnect) is delivered (trackerServer->nodeToTracker)', async () => {
        const messagePromise = waitForEvent(nodeToTracker, NodeToTrackerEvent.RELAY_MESSAGE_RECEIVED)
        const sentMessage = new RelayMessage({
            requestId: 'requestId',
            originator: PeerInfo.newNode('originatorNode'),
            targetNode: 'node1',
            subType: RelayMessageSubType.RTC_CONNECT,
            data: {}
        })
        trackerServer.send('node1', sentMessage)
        const [msg, source]: any = await messagePromise

        expect(msg).toBeInstanceOf(TrackerLayer.RelayMessage)
        expect(source).toEqual('trackerServer')
        expect(msg).toEqual(sentMessage)
    })

    it('sendData (rtcIceCandidate) is delivered (trackerServer->nodeToTracker)', async () => {
        const messagePromise = waitForEvent(nodeToTracker, NodeToTrackerEvent.RELAY_MESSAGE_RECEIVED)
        const sentMessage = new RelayMessage({
            requestId: 'requestId',
            originator: PeerInfo.newNode('originatorNode'),
            targetNode: 'node1',
            subType: RelayMessageSubType.ICE_CANDIDATE,
            data: {
                connectionId: 'connectionId',
                candidate: 'candidate',
                mid: 'mid'
            }
        })
        trackerServer.send('node1', sentMessage)
        const [msg, source]: any = await messagePromise

        expect(msg).toBeInstanceOf(TrackerLayer.RelayMessage)
        expect(source).toEqual('trackerServer')
        expect(msg).toEqual(sentMessage)
    })

    it('sendRtcOffer is delivered (nodeToTracker->trackerServer)', async () => {
        const messagePromise = waitForEvent(trackerServer, TrackerServerEvent.RELAY_MESSAGE_RECEIVED)
        nodeToTracker.sendRtcOffer(
            'trackerServer',
            'targetNode',
            'connectionid',
            PeerInfo.newNode('originatorNode'),
            'description'
        )
        const [msg, source]: any = await messagePromise

        if (typeof _streamr_electron_test === 'undefined') {
            expect(msg).toBeInstanceOf(TrackerLayer.RelayMessage)
        }
        expect(source).toEqual('node1')
        expect(msg.requestId).toMatch(UUID_REGEX)
        expect(msg.originator).toEqual(PeerInfo.newNode('originatorNode'))
        expect(msg.targetNode).toEqual('targetNode')
        expect(msg.subType).toEqual('rtcOffer')
        expect(msg.data).toEqual({
            connectionId: 'connectionid',
            description: 'description'
        })
    })

    it('sendRtcConnect is delivered (nodeToTracker->trackerServer)', async () => {
        const messagePromise = waitForEvent(trackerServer, TrackerServerEvent.RELAY_MESSAGE_RECEIVED)
        nodeToTracker.sendRtcConnect('trackerServer', 'targetNode', PeerInfo.newNode('originatorNode'))
        const [msg, source]: any = await messagePromise

        if (typeof _streamr_electron_test === 'undefined') {
            expect(msg).toBeInstanceOf(TrackerLayer.RelayMessage)
        }
        expect(source).toEqual('node1')
        expect(msg.requestId).toMatch(UUID_REGEX)
        expect(msg.originator).toEqual(PeerInfo.newNode('originatorNode'))
        expect(msg.targetNode).toEqual('targetNode')
        expect(msg.subType).toEqual('rtcConnect')
        expect(msg.data).toEqual({})
    })
    
})
