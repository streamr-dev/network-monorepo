import { RpcCommunicator, RpcCommunicatorEvent } from '@streamr/proto-rpc'
import { WebSocketConnectorClient } from '../../src/proto/DhtRpc.client'
import { generateId } from '../utils'
import {
    PeerDescriptor,
    WebSocketConnectionRequest,
    WebSocketConnectionResponse
} from '../../src/proto/DhtRpc'
import { MockWebSocketConnectorRpc } from '../utils'
import { DhtCallContext } from '../../src/rpc-protocol/DhtCallContext'

describe('WebSocketConnectorRpc', () => {
    let rpcCommunicator1: RpcCommunicator
    let rpcCommunicator2: RpcCommunicator
    let client1: WebSocketConnectorClient
    let client2: WebSocketConnectorClient

    const peerDescriptor1: PeerDescriptor = {
        peerId: generateId('peer1'),
        type: 0
    }

    const peerDescriptor2: PeerDescriptor = {
        peerId: generateId('peer2'),
        type: 0
    }

    beforeEach(() => {
        rpcCommunicator1 = new RpcCommunicator()
        rpcCommunicator1.registerRpcMethod(
            WebSocketConnectionRequest,
            WebSocketConnectionResponse,
            'requestConnection',
            MockWebSocketConnectorRpc.requestConnection
        )

        rpcCommunicator2 = new RpcCommunicator()
        rpcCommunicator2.registerRpcMethod(
            WebSocketConnectionRequest,
            WebSocketConnectionResponse,
            'requestConnection',
            MockWebSocketConnectorRpc.requestConnection
        )

        rpcCommunicator1.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, (message: Uint8Array, _ucallContext?: DhtCallContext) => {
            rpcCommunicator2.handleIncomingMessage(message)
        })

        rpcCommunicator2.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, (message: Uint8Array, _ucallContext?: DhtCallContext) => {
            rpcCommunicator1.handleIncomingMessage(message)
        })

        client1 = new WebSocketConnectorClient(rpcCommunicator1.getRpcClientTransport())
        client2 = new WebSocketConnectorClient(rpcCommunicator2.getRpcClientTransport())
    })

    afterEach(async () => {
        await rpcCommunicator1.stop()
        await rpcCommunicator2.stop()
    })

    it('Happy path', async () => {
        const response1 = client1.requestConnection({
            requester: peerDescriptor1,
            target: peerDescriptor2,
            ip: '127.0.0.1',
            port: 9099
        },
        { targetDescriptor: peerDescriptor2 },
        )
        const res1 = await response1.response
        await (expect(res1.accepted)).toEqual(true)

        const response2 = client2.requestConnection({
            requester: peerDescriptor2,
            target: peerDescriptor1,
            ip: '127.0.0.1',
            port: 9111
        },
        { targetDescriptor: peerDescriptor1 },
        )
        const res2 = await response2.response
        await (expect(res2.accepted)).toEqual(true)
    })
})
