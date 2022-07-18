import { DhtPeer } from '../../src/dht/DhtPeer'
import { RpcCommunicator, RpcCommunicatorEvent } from '@streamr/proto-rpc'
import { createWrappedClosestPeersRequest, getMockPeers, MockDhtRpc } from '../utils'
import {
    ClosestPeersRequest,
    ClosestPeersResponse,
    Message,
    MessageType,
    PeerDescriptor, PingRequest, PingResponse, RouteMessageAck, RouteMessageWrapper,
    RpcMessage
} from '../../src/proto/DhtRpc'
import { DhtRpcClient } from '../../src/proto/DhtRpc.client'
import { generateId } from '../utils'
import { DhtCallContext } from '../../src/rpc-protocol/DhtCallContext'

describe('DhtPeer', () => {
    let dhtPeer: DhtPeer
    let clientRpcCommunicator: RpcCommunicator
    let serverRpcCommunicator: RpcCommunicator
    const appId = 'test'

    const clientPeerDescriptor: PeerDescriptor = {
        peerId: generateId('dhtPeer'),
        type: 0
    }
    const serverPeerDescriptor: PeerDescriptor = {
        peerId: generateId('server'),
        type: 0
    }

    beforeEach(() => {
        clientRpcCommunicator = new RpcCommunicator()
        serverRpcCommunicator = new RpcCommunicator()

        serverRpcCommunicator.registerRpcMethod(ClosestPeersRequest, ClosestPeersResponse, 'getClosestPeers', MockDhtRpc.getClosestPeers)
        serverRpcCommunicator.registerRpcMethod(PingRequest, PingResponse, 'ping', MockDhtRpc.ping)
        serverRpcCommunicator.registerRpcMethod(RouteMessageWrapper, RouteMessageAck, 'routeMessage', MockDhtRpc.routeMessage)

        clientRpcCommunicator.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, (message: Uint8Array, _ucallContext?: DhtCallContext) => {
       
            serverRpcCommunicator.handleIncomingMessage(message)
        })

        serverRpcCommunicator.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, (message: Uint8Array, _ucallContext?: DhtCallContext) => {
            clientRpcCommunicator.handleIncomingMessage(message)
        })

        const client = new DhtRpcClient(clientRpcCommunicator.getRpcClientTransport())
        dhtPeer = new DhtPeer(serverPeerDescriptor, client)
    })

    afterEach(() => {
        clientRpcCommunicator.stop()
        serverRpcCommunicator.stop()
    })

    it('Ping happy path', async () => {
        const active = await dhtPeer.ping(clientPeerDescriptor)
        expect(active).toEqual(true)
    })

    it('getClosestPeers happy path', async () => {
        const neighbors = await dhtPeer.getClosestPeers(clientPeerDescriptor)
        expect(neighbors.length).toEqual(getMockPeers().length)
    })

    it('routeMessage happy path', async () => {
        const rpcWrapper = createWrappedClosestPeersRequest(clientPeerDescriptor, serverPeerDescriptor)
        const routed: Message = {
            appId: appId,
            messageId: 'routed',
            messageType: MessageType.RPC,
            body: RpcMessage.toBinary(rpcWrapper)
        }
        const routable = await dhtPeer.routeMessage({
            messageId: 'routed',
            message: Message.toBinary(routed),
            sourcePeer: clientPeerDescriptor,
            destinationPeer: serverPeerDescriptor,
            appId: 'unit-test'
        })
        expect(routable).toEqual(true)
    })

    it('ping error path', async () => {
        serverRpcCommunicator.registerRpcMethod(PingRequest, PingResponse, 'ping', MockDhtRpc.throwPingError)
        const active = await dhtPeer.ping(clientPeerDescriptor)
        expect(active).toEqual(false)
    })

    it('getClosestPeers error path', async () => {
        serverRpcCommunicator.registerRpcMethod(ClosestPeersRequest, ClosestPeersResponse, 'getClosestPeers', MockDhtRpc.throwGetClosestPeersError)
        const neighborList = await dhtPeer.getClosestPeers(clientPeerDescriptor)
        expect(neighborList.length).toEqual(0)
    })

    it('routeMessage error path', async () => {
        serverRpcCommunicator.registerRpcMethod(RouteMessageWrapper, RouteMessageAck, 'routeMessage', MockDhtRpc.throwRouteMessageError)
        const rpcWrapper = createWrappedClosestPeersRequest(clientPeerDescriptor, serverPeerDescriptor)
        const routed: Message = {
            appId: appId,
            messageId: 'routed',
            messageType: MessageType.RPC,
            body: RpcMessage.toBinary(rpcWrapper)
        }
        const routable = await dhtPeer.routeMessage({
            messageId: 'routed',
            message: Message.toBinary(routed),
            sourcePeer: clientPeerDescriptor,
            destinationPeer: serverPeerDescriptor,
            appId: 'unit-test'
        })
        expect(routable).toEqual(false)
    })

})
