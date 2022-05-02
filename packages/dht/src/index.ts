import { DhtTransportClient } from './transport/DhtTransportClient'
import { DhtRpcClient } from './proto/DhtRpc.client'
import { RpcCommunicator } from './transport/RpcCommunicator'
import { MockConnectionManager } from './connection/MockConnectionManager'
import { DhtTransportServer } from './transport/DhtTransportServer'
import { generateId } from './dht/helpers'
import { DhtNode } from './dht/DhtNode'
import { PeerID } from './PeerID'

const main = async () => {
    const id = generateId('peer')
    const clientTransport = new DhtTransportClient()
    const serverTransport = new DhtTransportServer()
    const mockConnectionLayer = new MockConnectionManager()
    const rpcCommunicator = new RpcCommunicator(mockConnectionLayer, clientTransport, serverTransport)
    const client = new DhtRpcClient(clientTransport)
    new DhtNode(PeerID.fromValue(id), client, clientTransport, serverTransport, rpcCommunicator)
}

main()