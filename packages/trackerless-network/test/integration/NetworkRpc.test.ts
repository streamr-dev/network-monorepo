import { PeerDescriptor } from '@streamr/dht'
import { RpcCommunicator, CallContext, RpcCommunicatorEvent } from '@streamr/proto-rpc'
import { NetworkRpcClient } from '../../src/proto/NetworkRpc.client'
import { DataMessage, MessageRef } from '../../src/proto/NetworkRpc'
import { waitForCondition } from 'streamr-test-utils'
import { Empty } from '../../src/proto/google/protobuf/empty'
import { ServerCallContext } from '@protobuf-ts/runtime-rpc'

describe('Network RPC', () => {
    const peer2: PeerDescriptor = {
        peerId: new Uint8Array([2,2,2]),
        type: 1
    }
    let rpcCommunicator1: RpcCommunicator
    let rpcCommunicator2: RpcCommunicator
    let client: NetworkRpcClient

    let recvCounter = 0

    beforeEach(() => {
        rpcCommunicator1 = new RpcCommunicator()
        rpcCommunicator2 = new RpcCommunicator()
        rpcCommunicator1.on(RpcCommunicatorEvent.OUTGOING_MESSAGE, (message: Uint8Array, _ucallContext?: CallContext) => {
            rpcCommunicator2.handleIncomingMessage(message)
        })
        client = new NetworkRpcClient(rpcCommunicator1.getRpcClientTransport())
        rpcCommunicator2.registerRpcNotification(
            DataMessage,
            'sendData',
            async (_msg: DataMessage, _context: ServerCallContext): Promise<Empty> => {
                recvCounter += 1
                return Empty
            }
        )
    })

    afterEach(() => {
        rpcCommunicator1.stop()
        rpcCommunicator2.stop()
    })

    it('sends Data', async () => {
        const messageRef: MessageRef = {
            sequenceNumber: 0,
            timestamp: 0
        }
        const data: DataMessage = {
            content: 'data',
            senderId: 'peer1',
            messageRef,
            streamPartId: 'testStream'
        }
        await client.sendData(data,
            { targetDescriptor: peer2, notification: 'notification' }
        )
        await waitForCondition(() => recvCounter === 1)
    })
})
