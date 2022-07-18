/** 
 * Example that demonstrates passing context information through the RPC stack 
 * */ 

import { ServerCallContext } from '@protobuf-ts/runtime-rpc'
import { RpcCommunicator, RpcCommunicatorEvents, CallContext } from '@streamr/proto-rpc'
import { RoutedHelloRequest, RoutedHelloResponse } from './proto/RoutedHelloRpc'
import { IRoutedHelloRpc } from './proto/RoutedHelloRpc.server'
import { RoutedHelloRpcClient } from './proto/RoutedHelloRpc.client'

// Rpc service
class HelloService implements IRoutedHelloRpc {
    constructor(public serviceId: string) {
        this.sayHello = this.sayHello.bind(this)
    }

    async sayHello(request: RoutedHelloRequest, cont: ServerCallContext): Promise<RoutedHelloResponse> {
        // proto-rpc always passes a CallContext instance to the RPC methods
        // type-casting is safe here 
        const context = cont as CallContext
        let sourceId = 'unknown'

        if (context && context['sourceId']) {
            sourceId = context['sourceId'] as string
        }

        // eslint-disable-next-line no-console
        console.log('sayHello() called on server ' + this.serviceId + " with context parameter sourceId " + sourceId)
        return { greeting: 'Hello ' + request.myName + '!' }
    }
}

const run = async () => {

    const clientCommunicators: Record<string, RpcCommunicator> = {}

    // Setup server
    const serverCommunicator1 = new RpcCommunicator()
    const helloService1 = new HelloService("1")
    serverCommunicator1.registerRpcMethod(RoutedHelloRequest, RoutedHelloResponse, 'sayHello', helloService1.sayHello)

    // Setup server 2
    const serverCommunicator2 = new RpcCommunicator()
    const helloService2 = new HelloService("2")    
    serverCommunicator2.registerRpcMethod(RoutedHelloRequest, RoutedHelloResponse, 'sayHello', helloService2.sayHello)

    // Setup client1
    const communicator1 = new RpcCommunicator()
    const helloClient1 = new RoutedHelloRpcClient(communicator1.getRpcClientTransport())
    clientCommunicators['1'] = communicator1

    // Setup client2
    const communicator2 = new RpcCommunicator()
    const helloClient2 = new RoutedHelloRpcClient(communicator2.getRpcClientTransport())
    clientCommunicators['2'] = communicator2

    // Simulate a network connection, in real life the message blobs would be transferred over a network

    serverCommunicator1.on(RpcCommunicatorEvents.OUTGOING_MESSAGE, (msgBody: Uint8Array, callContext?: CallContext) => {

        // Send the reply message to the calling client based on sourceId passed 
        // through the network stack in the context information
        if (callContext!.sourceId) {
            const clientId = callContext!["sourceId"] as string
            clientCommunicators[clientId].handleIncomingMessage(msgBody)
        }
    })

    serverCommunicator2.on(RpcCommunicatorEvents.OUTGOING_MESSAGE, (msgBody: Uint8Array, callContext?: CallContext) => {
        if (callContext!.sourceId) {
            const clientId = callContext!["sourceId"] as string
            clientCommunicators[clientId].handleIncomingMessage(msgBody)
        }
    })

    communicator1.on(RpcCommunicatorEvents.OUTGOING_MESSAGE, (msgBody: Uint8Array, clientContext?: CallContext) => {
       
        // Choose the server to send the message to based on context information passed
        // through the RPC stack as client context information
        let server: RpcCommunicator

        if (clientContext && clientContext['targetServerId'] && clientContext['targetServerId'] == '2') {
            server = serverCommunicator2
        } else {
            server = serverCommunicator1
        }

        // Here you would transport the msgBody over network to the server
        // ...
        // At the server you would pass the id of the calling client as context information to the server.
        // The server is free to choose what to use as the id of the calling client; it might use, for example, 
        // the id of the network socket, something negotiated during connection handshake, or something 
        // passed on in every network payload.
        //  
        // The context information gets passed uncahged through the RPC stack, so the reply message can be
        // routed to the correct client. 

        const serverContext = new CallContext()
        serverContext["sourceId"] = "1"
        
        server.handleIncomingMessage(msgBody, serverContext)
    })

    communicator2.on(RpcCommunicatorEvents.OUTGOING_MESSAGE, (msgBody: Uint8Array, clientContext?: CallContext) => {
        let server: RpcCommunicator

        if (clientContext && clientContext['targetServerId'] && clientContext['targetServerId'] == '2') {
            server = serverCommunicator2
        } else {
            server = serverCommunicator1
        }
        const serverContext = new CallContext()
        serverContext["sourceId"] = "2"
        
        server.handleIncomingMessage(msgBody, serverContext)
    })

    const result1 = helloClient1.sayHello({ myName: 'Alice' }, { targetServerId: '2' })
    const { greeting: greeting1 } = await result1.response
    // eslint-disable-next-line no-console
    console.log("Client 1 (Alice) got message from server: " + greeting1)

    const result2 = await helloClient2.sayHello({ myName: 'Bob' })
    const { greeting: greeting2 } = await result2.response
    // eslint-disable-next-line no-console
    console.log("Client 2 (Bob) got message from server: " + greeting2)

    communicator1.stop()
    communicator2.stop()
}

run()
