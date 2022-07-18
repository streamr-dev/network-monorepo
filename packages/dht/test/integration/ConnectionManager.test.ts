import { ConnectionManager } from "../../src/connection/ConnectionManager"
import { Event as ITransportEvent } from "../../src/transport/ITransport"
import { Message, MessageType, NodeType, PeerDescriptor } from "../../src/proto/DhtRpc"
import { createPeerDescriptor } from '../utils'
import { waitForEvent } from '@streamr/utils'
import { Event as ConnectionEvent } from '../../src/connection/IConnection'
import { ClientWebSocket } from '../../src/connection/WebSocket/ClientWebSocket'
import { SimulatorTransport } from '../../src/connection/SimulatorTransport'
import { PeerID } from '../../src/helpers/PeerID'
import { Simulator } from '../../src/connection/Simulator'

describe('ConnectionManager', () => {
    const appId = 'demo'

    const mockPeerDescriptor1: PeerDescriptor = {
        peerId: PeerID.fromString("tester1").value,
        type: NodeType.NODEJS
    }
    const mockPeerDescriptor2: PeerDescriptor = {
        peerId: PeerID.fromString("tester2").value,
        type: NodeType.NODEJS
    }
    const simulator = new Simulator()

    const mockTransport = new SimulatorTransport(mockPeerDescriptor1, simulator)
    const mockConnectorTransport1 = new SimulatorTransport(mockPeerDescriptor1, simulator)
    const mockConnectorTransport2 = new SimulatorTransport(mockPeerDescriptor2, simulator)

    it('Can start alone', async () => {
        const connectionManager = new ConnectionManager({ transportLayer: mockTransport, webSocketHost: 'localhost', webSocketPort: 9991 })

        const result = await connectionManager.start()
        expect(result.ip).toEqual('localhost')
        expect(result.openInternet).toEqual(true)

        await connectionManager.stop()
    })

    it('Throws an async exception if fails to connect to entrypoints', async () => {

        const connectionManager = new ConnectionManager({
            transportLayer: mockTransport,
            webSocketPort: 9992, entryPoints: [
                { peerId: Uint8Array.from([1, 2, 3]), type: NodeType.NODEJS, websocket: { ip: 'localhost', port: 123 } }
            ]
        })
        
        await expect(connectionManager.start())
            .rejects
            .toThrow('Failed to connect to the entrypoints')

        await connectionManager.stop()
    })

    it('Can probe connectivity in open internet', async () => {
        const connectionManager1 = new ConnectionManager({ transportLayer: mockTransport, webSocketHost: 'localhost', webSocketPort: 9993 })

        const result = await connectionManager1.start()
        connectionManager1.enableConnectivity(createPeerDescriptor(result))

        expect(result.ip).toEqual('localhost')
        expect(result.openInternet).toEqual(true)

        const connectionManager2 = new ConnectionManager({
            transportLayer: mockConnectorTransport2,
            webSocketPort: 9994, entryPoints: [
                { peerId: Uint8Array.from([1, 2, 3]), type: NodeType.NODEJS, websocket: { ip: 'localhost', port: 9993 } }
            ]
        })
       
        const result2 = await connectionManager2.start()
        connectionManager2.enableConnectivity(createPeerDescriptor(result2))

        expect(result2.ip).toEqual('127.0.0.1')
        expect(result2.openInternet).toEqual(true)

        await connectionManager1.stop()
        await connectionManager2.stop()
    })

    it('Can send data to other connectionmanager over websocket', async () => {
        const connectionManager1 = new ConnectionManager({ transportLayer: mockConnectorTransport1, webSocketHost: 'localhost', webSocketPort: 9995 })

        const result = await connectionManager1.start()
        const peerDescriptor = createPeerDescriptor(result)
        connectionManager1.enableConnectivity(peerDescriptor)

        expect(result.ip).toEqual('localhost')
        expect(result.openInternet).toEqual(true)

        const connectionManager2 = new ConnectionManager({
            transportLayer: mockConnectorTransport2,
            webSocketPort: 9996, entryPoints: [
                peerDescriptor 
            ]
        })

        const result2 = await connectionManager2.start()
        const peerDescriptor2 = createPeerDescriptor(result2)
        connectionManager2.enableConnectivity(peerDescriptor2)

        expect(result2.ip).toEqual('127.0.0.1')
        expect(result2.openInternet).toEqual(true)

        const arr = new Uint8Array(10)
        const msg: Message = {
            appId: appId,
            messageType: MessageType.RPC, 
            messageId: '1',
            body: arr
        }

        const promise = new Promise<void>((resolve, _reject) => {
            connectionManager2.on(ITransportEvent.DATA, async (message: Message, _peerDescriptor: PeerDescriptor) => {
                expect(message.messageType).toBe(MessageType.RPC)
                resolve()
            })
        })
        connectionManager1.send(msg, peerDescriptor2)
        
        await promise
        
        await connectionManager1.stop()
        await connectionManager2.stop()
    })

    it('Can disconnect', async () => {
        const connectionManager1 = new ConnectionManager({ transportLayer: mockConnectorTransport1, webSocketHost: 'localhost', webSocketPort: 9997 })

        const result = await connectionManager1.start()
        const peerDescriptor = createPeerDescriptor(result)
        connectionManager1.enableConnectivity(peerDescriptor)

        expect(result.ip).toEqual('localhost')
        expect(result.openInternet).toEqual(true)

        const connectionManager2 = new ConnectionManager({
            transportLayer: mockConnectorTransport2,
            webSocketPort: 9999, entryPoints: [
                peerDescriptor
            ]
        })

        const result2 = await connectionManager2.start()
        const peerDescriptor2 = createPeerDescriptor(result2)
        connectionManager2.enableConnectivity(peerDescriptor2)

        expect(result2.ip).toEqual('127.0.0.1')
        expect(result2.openInternet).toEqual(true)

        const arr = new Uint8Array(10)
        const msg: Message = {
            appId: appId,
            messageType: MessageType.RPC,
            messageId: '1',
            body: arr
        }

        const promise = new Promise<void>((resolve, _reject) => {
            connectionManager2.on(ITransportEvent.DATA, async (message: Message, _peerDescriptor: PeerDescriptor) => {
                expect(message.messageType).toBe(MessageType.RPC)
                resolve()
            })
        })
        connectionManager1.send(msg, peerDescriptor2)

        await promise
        await Promise.all([
            waitForEvent(connectionManager2.getConnection(peerDescriptor) as ClientWebSocket, ConnectionEvent.DISCONNECTED),
            connectionManager1.disconnect(peerDescriptor2, undefined, 100)
        ])
        await connectionManager1.stop()
        await connectionManager2.stop()
    })

    afterAll(async () => {
    })
    
})
