import { ClosestPeersResponse, PeerDescriptor } from '../proto/TestProtos'
import { RpcMessage } from '../../src/proto/ProtoRpc'
import { RpcCommunicator, RpcCommunicatorEvent } from '../../src/RpcCommunicator'
import { DhtRpcClient } from '../proto/TestProtos.client'
import { getMockPeers } from '../utils'
import { CallContext } from '../../src/ServerRegistry'

describe('DhtClientRpcTransport', () => {
    it('Happy Path getClosestNeighbors', async () => {
        const rpcCommunicator = new RpcCommunicator()
        rpcCommunicator.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, (message: Uint8Array, _ucallContext?: CallContext) => {
            const request = RpcMessage.fromBinary(message)
            const responseBody: ClosestPeersResponse = {
                peers: getMockPeers(),
                nonce: 'TO BE REMOVED'
            }
            
            const response: RpcMessage = {
                header: {
                    response: 'hiihii'
                },
                body: ClosestPeersResponse.toBinary(responseBody),
                requestId: request.requestId
            }
            
            rpcCommunicator.handleIncomingMessage(RpcMessage.toBinary(response))
        })

        const client = new DhtRpcClient(rpcCommunicator.getRpcClientTransport())

        const peerDescriptor: PeerDescriptor = {
            peerId: new Uint8Array([1, 2, 3]),
            type: 0
        }
        const response = client.getClosestPeers({ peerDescriptor, nonce: '1' })
        const res = await response.response
        expect(res.peers.length).toEqual(4)
        expect(res.peers[0]).toEqual(getMockPeers()[0])
        expect(res.peers[1]).toEqual(getMockPeers()[1])
        expect(res.peers[2]).toEqual(getMockPeers()[2])
        expect(res.peers[3]).toEqual(getMockPeers()[3])
    })
})
