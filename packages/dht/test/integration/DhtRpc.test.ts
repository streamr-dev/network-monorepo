import { getMockPeers, MockDhtRpc } from '../utils'
import { RpcCommunicator, RpcCommunicatorEvent, RpcError } from '@streamr/proto-rpc'
import { DhtRpcClient } from '../../src/proto/DhtRpc.client'
import { generateId } from '../utils'
import { ClosestPeersRequest, ClosestPeersResponse, PeerDescriptor } from '../../src/proto/DhtRpc'
import { wait } from '@streamr/utils'
import { ServerCallContext } from '@protobuf-ts/runtime-rpc'
import { DhtCallContext } from '../../src/rpc-protocol/DhtCallContext'

describe('DhtRpc', () => {
    let rpcCommunicator1: RpcCommunicator
    let rpcCommunicator2: RpcCommunicator
    let client1: DhtRpcClient
    let client2: DhtRpcClient

    const peerDescriptor1: PeerDescriptor = {
        peerId: generateId('peer1'),
        type: 0
    }

    const peerDescriptor2: PeerDescriptor = {
        peerId: generateId('peer2'),
        type: 0
    }

    const outgoingListener2 = (message: Uint8Array, _ucallContext?: DhtCallContext) => {
        rpcCommunicator1.handleIncomingMessage(message)
    }

    beforeEach(() => {
        rpcCommunicator1 = new RpcCommunicator()
        rpcCommunicator1.registerRpcMethod(ClosestPeersRequest, ClosestPeersResponse, 'getClosestPeers', MockDhtRpc.getClosestPeers)

        rpcCommunicator2 = new RpcCommunicator()
        rpcCommunicator2.registerRpcMethod(ClosestPeersRequest, ClosestPeersResponse, 'getClosestPeers', MockDhtRpc.getClosestPeers)

        rpcCommunicator1.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, (message: Uint8Array, _ucallContext?: DhtCallContext) => {
            rpcCommunicator2.handleIncomingMessage(message)
        })

        rpcCommunicator2.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, outgoingListener2)
        
        client1 = new DhtRpcClient(rpcCommunicator1.getRpcClientTransport())
        client2 = new DhtRpcClient(rpcCommunicator1.getRpcClientTransport())
    })

    afterEach(async () => {
        await rpcCommunicator1.stop()
        await rpcCommunicator2.stop()
    })
    
    it('Happy path', async () => {
        const response1 = client1.getClosestPeers(
            { peerDescriptor: peerDescriptor1, nonce: '1' },
            { targetDescriptor: peerDescriptor2 }
        )
        const res1 = await response1.response
        expect(res1.peers).toEqual(getMockPeers())

        const response2 = client2.getClosestPeers(
            { peerDescriptor: peerDescriptor2, nonce: '1' },
            { targetDescriptor: peerDescriptor1 }
        )
        const res2 = await response2.response
        expect(res2.peers).toEqual(getMockPeers())
    })
    
    it('Default RPC timeout, client side', async () => {
        rpcCommunicator2.off(RpcCommunicatorEvent.OUTGOING_MESSAGE, outgoingListener2)
        rpcCommunicator2.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, async (_umessage: Uint8Array, _ucallContext?: DhtCallContext) => {
            await wait(3000)
        })
        const response2 = client2.getClosestPeers(
            { peerDescriptor: peerDescriptor2, nonce: '1' },
            { targetDescriptor: peerDescriptor1 }
        )
        await expect(response2.response).rejects.toEqual(
            new RpcError.RpcTimeout('Rpc request timed out')
        )
    }, 15000)

    it('Server side timeout', async () => {
        let timeout: NodeJS.Timeout
        
        function respondGetClosestPeersWithTimeout(_request: ClosestPeersRequest, _context: ServerCallContext): Promise<ClosestPeersResponse> {
            const neighbors = getMockPeers()
            const response: ClosestPeersResponse = {
                peers: neighbors,
                nonce: 'why am i still here'
            }
            return new Promise((resolve, _reject) => {
                timeout = setTimeout(() => {
                    resolve(response)
                }, 5000)
            })
        }
        
        rpcCommunicator2.registerRpcMethod(ClosestPeersRequest, ClosestPeersResponse, 'getClosestPeers', respondGetClosestPeersWithTimeout)
        const response = client2.getClosestPeers(
            { peerDescriptor: peerDescriptor2, nonce: '1' },
            { targetDescriptor: peerDescriptor1 }
        )
        await expect(response.response).rejects.toEqual(
            new RpcError.RpcTimeout('Server timed out on request')
        )
        clearTimeout(timeout!)
    })
    
    it('Server responds with error on unknown method', async () => {
        const response = client2.ping(
            { nonce: '1' },
            { targetDescriptor: peerDescriptor1 }
        )
        await expect(response.response).rejects.toEqual(
            new RpcError.UnknownRpcMethod('Server does not implement method ping')
        )
    })
})
