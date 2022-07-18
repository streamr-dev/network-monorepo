import { ServerCallContext } from '@protobuf-ts/runtime-rpc'
import { RpcCommunicator, RpcCommunicatorEvents, CallContext } from '@streamr/proto-rpc'
import { HelloRequest, HelloResponse } from './proto/ErrorRpc'
import { IErrorRpc } from './proto/ErrorRpc.server'
import { ErrorRpcClient } from './proto/ErrorRpc.client'
import { Err } from '../../src/errors'

// Rpc service
class ErrorService implements IErrorRpc {
    async timeout(request: HelloRequest, _context: ServerCallContext): Promise<HelloResponse> {
        return new Promise((resolve, _reject) => {
            setTimeout(() => {
                return resolve({ greeting: 'Hello ' + request.myName + '!' })
            }, 2000)
        })
    }
    async serverError(_request: HelloRequest, _context: ServerCallContext): Promise<HelloResponse> {
        throw new Error('Server Error')
    }
    async unknownMethod(_request: HelloRequest, _context: ServerCallContext): Promise<HelloResponse> {
        throw new Err.NotImplemented()
    }
}

const run = async () => {
    // Setup server
    const communicator1 = new RpcCommunicator()
    const errorService = new ErrorService()
    communicator1.registerRpcMethod(HelloRequest, HelloResponse, 'timeout', errorService.timeout)
    communicator1.registerRpcMethod(HelloRequest, HelloResponse, 'serverError', errorService.serverError)

    // Setup client
    const communicator2 = new RpcCommunicator()
    const helloClient = new ErrorRpcClient(communicator2.getRpcClientTransport())

    // Simulate a network connection, in real life the message blobs would be transferred over a network
    communicator1.on(RpcCommunicatorEvents.OUTGOING_MESSAGE, (msgBody: Uint8Array, _ucallContext?: CallContext) => {
        communicator2.handleIncomingMessage(msgBody)
    })
    communicator2.on(RpcCommunicatorEvents.OUTGOING_MESSAGE, (msgBody: Uint8Array, _ucallContext?: CallContext) => {
        communicator1.handleIncomingMessage(msgBody)
    })

    try {
        const results = helloClient.timeout({ myName: 'Alice' })
        await results.response
    } catch (err) {
        // eslint-disable-next-line no-console
        console.log(err)
    }

    try {
        const results = helloClient.serverError({ myName: 'Alice' })
        await results.response
    } catch (err) {
        // eslint-disable-next-line no-console
        console.log(err)
    }

    try {
        // UnknownMethod is not registered at the server!
        const results = helloClient.unknownMethod({ myName: 'Alice' })
        await results.response
    } catch (err) {
        // eslint-disable-next-line no-console
        console.log(err)
    }

    communicator1.stop()
    communicator2.stop()
}

run()
