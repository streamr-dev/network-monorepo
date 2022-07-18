import { ConnectionManager } from '../../src/connection/ConnectionManager'
import { Simulator } from '../../src/connection/Simulator'
import { SimulatorTransport } from '../../src/connection/SimulatorTransport'
import { Message, MessageType, NodeType, PeerDescriptor } from '../../src/proto/DhtRpc'
import { PeerID } from '../../src/helpers/PeerID'
import { waitForCondition } from 'streamr-test-utils'
import { ConnectionType } from '../../src/connection/IConnection'
import { ITransport } from '../../src/transport/ITransport'
import { NodeWebRtcConnection } from '../../src/connection/WebRTC/NodeWebRtcConnection'
import * as Err from '../../src/helpers/errors'

describe('WebRTC Connection Management', () => {

    let manager1: ConnectionManager
    let manager2: ConnectionManager
    
    const simulator = new Simulator()

    const peerDescriptor1: PeerDescriptor = {
        peerId: PeerID.fromString("peer1").value,
        type: NodeType.NODEJS,
    }

    const peerDescriptor2: PeerDescriptor = {
        peerId: PeerID.fromString("peer2").value,
        type: NodeType.NODEJS,
    }

    let connectorTransport1: ITransport
    let connectorTransport2: ITransport

    beforeEach(async () => {

        connectorTransport1 = new SimulatorTransport(peerDescriptor1, simulator)
        manager1 = new ConnectionManager({ transportLayer: connectorTransport1 })
        
        connectorTransport2 = new SimulatorTransport(peerDescriptor2, simulator)
        manager2 = new ConnectionManager({ transportLayer: connectorTransport2 })

        await manager1.start()
        await manager2.start()

        manager1.enableConnectivity(peerDescriptor1)
        manager2.enableConnectivity(peerDescriptor2)
    })

    afterEach(async () => {
        await manager1.stop()
        await manager2.stop()
    })

    const appId = 'dummy'

    it('Peer1 can open WebRTC Datachannels', async () => {
        const dummyMessage: Message = {
            appId: appId,
            body: new Uint8Array(),
            messageType: MessageType.RPC,
            messageId: 'mockerer'
        }
        
        await manager1.send(dummyMessage, peerDescriptor2)
        
        await waitForCondition(
            () => {
                return (!!manager1.getConnection(peerDescriptor2)
                    && manager1.getConnection(peerDescriptor2)!.connectionType === ConnectionType.WEBRTC)
            }
        )

        await waitForCondition(
            () => {
                return (!!manager2.getConnection(peerDescriptor1)
                && manager2.getConnection(peerDescriptor1)!.connectionType === ConnectionType.WEBRTC)
            }
        )

        await waitForCondition(() => (manager2.getConnection(peerDescriptor1) as NodeWebRtcConnection).isOpen())
        await waitForCondition(() => (manager1.getConnection(peerDescriptor2) as NodeWebRtcConnection).isOpen())
    })
    
    it('Peer2 can open WebRTC Datachannel', async () => {
        const dummyMessage: Message = {
            appId: appId,
            body: new Uint8Array(),
            messageType: MessageType.RPC,
            messageId: 'mockerer'
        }
        await manager2.send(dummyMessage, peerDescriptor1)
        await waitForCondition(
            () => {
                return (!!manager1.getConnection(peerDescriptor2)
                    && manager1.getConnection(peerDescriptor2)!.connectionType === ConnectionType.WEBRTC)
            }
        )
        await waitForCondition(
            () => {
                return (!!manager2.getConnection(peerDescriptor1)
                    && manager2.getConnection(peerDescriptor1)!.connectionType === ConnectionType.WEBRTC)
            }
        )
        await waitForCondition(() => (manager2.getConnection(peerDescriptor1) as NodeWebRtcConnection).isOpen())
        await waitForCondition(() => (manager1.getConnection(peerDescriptor2) as NodeWebRtcConnection).isOpen())
    })

    it('Connecting to self throws', async () => {
        const dummyMessage: Message = {
            appId: appId,
            body: new Uint8Array(),
            messageType: MessageType.RPC,
            messageId: 'mockerer'
        }
        await expect(manager1.send(dummyMessage, peerDescriptor1))
            .rejects
            .toEqual(new Err.CannotConnectToSelf('Cannot send to self'))
    })
})
