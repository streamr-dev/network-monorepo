import WebSocket from 'ws'
import qs from 'qs'
import StreamrClient from 'streamr-client'
import { waitForCondition, waitForEvent } from 'streamr-test-utils'
import { WebsocketServer } from '../../../../src/plugins/websocket/WebsocketServer'

const PORT = 12398
const MOCK_STREAM_ID = '0x1234567890123456789012345678901234567890/mock-path'
const MOCK_MESSAGE = {
    foo: 'bar'
}
const PATH_PUBLISH_MOCK_STREAM = `/streams/${encodeURIComponent(MOCK_STREAM_ID)}/publish`
const PATH_SUBSCRIBE_MOCK_STREAM = `/streams/${encodeURIComponent(MOCK_STREAM_ID)}/subscribe`
const REQUIRED_API_KEY = 'required-api-key'

const createTestClient = (path: string, queryParams?: any): WebSocket => {
    const queryParamsSuffix = qs.stringify({
        apiKey: REQUIRED_API_KEY,
        ...queryParams
    })
    return new WebSocket(`ws://localhost:${PORT}${path}?${queryParamsSuffix}`)
}

describe('WebsocketServer', () => {

    let wsServer: WebsocketServer
    let wsClient: WebSocket
    let streamrClient: Partial<StreamrClient>

    const assertConnectionError = async (expectedHttpStatus: number) => {
        const [ error ] = await waitForEvent(wsClient, 'error')
        expect((error as Error).message).toBe(`Unexpected server response: ${expectedHttpStatus}`)
    }

    beforeEach(async () => {
        streamrClient = {
            publish: jest.fn().mockResolvedValue(undefined),
            subscribe: jest.fn().mockResolvedValue(undefined),
        } as Partial<StreamrClient>
        wsServer = new WebsocketServer(streamrClient as StreamrClient)
        await wsServer.start(PORT, {
            isValidAuthentication: (apiKey?: string) => (apiKey === REQUIRED_API_KEY)
        })
    })

    afterEach(async () => {
        wsClient?.close()
        await wsServer?.stop()
    })

    describe.each([
        ['/streams/dummy/invalid-action'],
        ['/invalid-path'],
        ['/']
    ])('invalid connection url', (path: string) => {
        it(path, async () => {
            wsClient = createTestClient(path)
            await assertConnectionError(400)
        })
    })

    describe('publish', () => {

        const publish = async (queryParams?: any) => {
            wsClient = createTestClient(PATH_PUBLISH_MOCK_STREAM, queryParams)
            await waitForEvent(wsClient, 'open')
            wsClient.send(JSON.stringify(MOCK_MESSAGE))
            await waitForCondition(() => ((streamrClient.publish as any).mock.calls.length === 1))
        }

        it('without parameters', async () => {
            await publish()
            expect(streamrClient.publish).toBeCalledWith(
                {
                    id: MOCK_STREAM_ID,
                    partition: undefined
                }, 
                MOCK_MESSAGE, undefined, undefined
            )
        })

        it('valid partition', async () => {
            await publish({ partition: 123 })
            expect(streamrClient.publish).toBeCalledWith(
                {
                    id: MOCK_STREAM_ID,
                    partition: 123
                }, 
                MOCK_MESSAGE, undefined, undefined
            )
        })

        it('valid partitionKey', async () => {
            await publish({ partitionKey: 'mock-key' })
            expect(streamrClient.publish).toBeCalledWith(
                {
                    id: MOCK_STREAM_ID,
                    partition: undefined
                }, 
                MOCK_MESSAGE, undefined, 'mock-key'
            )
        })

        it('invalid partition', async () => {
            wsClient = createTestClient(PATH_PUBLISH_MOCK_STREAM, { partition: -1 })
            await assertConnectionError(400)
        })

        it('both partition and partitionKey', async () => {
            wsClient = createTestClient(PATH_PUBLISH_MOCK_STREAM, { partition: 123, partitionKey: 'mock-key' })
            await assertConnectionError(400)
        })

        it('invalid json', async () => {
            wsClient = createTestClient(PATH_PUBLISH_MOCK_STREAM)
            await waitForEvent(wsClient, 'open')
            wsClient.send('invalid-payload')
            const closeEvent = await waitForEvent(wsClient, 'close')
            expect(closeEvent[0]).toBeTruthy()
            expect(closeEvent[1]).toBe('Unable to publish: Payload is not a JSON string')
        })

    })

    describe('subscribe', () => {

        it('without parameters', async () => {
            wsClient = createTestClient(PATH_SUBSCRIBE_MOCK_STREAM)
            await waitForEvent(wsClient, 'open')
            expect(streamrClient.subscribe).toBeCalledTimes(1)
            expect(streamrClient.subscribe).toBeCalledWith({ id: MOCK_STREAM_ID, partition: undefined }, expect.anything())
        })

        it('valid partitions', async () => {
            wsClient = createTestClient(PATH_SUBSCRIBE_MOCK_STREAM, { partitions: '0,2,5' })
            await waitForEvent(wsClient, 'open')
            expect(streamrClient.subscribe).toBeCalledTimes(3)
            expect(streamrClient.subscribe).toHaveBeenNthCalledWith(1, { id: MOCK_STREAM_ID, partition: 0 }, expect.anything())
            expect(streamrClient.subscribe).toHaveBeenNthCalledWith(2, { id: MOCK_STREAM_ID, partition: 2 }, expect.anything())
            expect(streamrClient.subscribe).toHaveBeenNthCalledWith(3, { id: MOCK_STREAM_ID, partition: 5 }, expect.anything())
        })
        
        it('invalid partitions', async () => {
            wsClient = createTestClient(PATH_SUBSCRIBE_MOCK_STREAM, { partitions: '111,-222,333' })
            await assertConnectionError(400)
        })

        it('receive message from StreamrClient', async () => {
            wsClient = createTestClient(PATH_SUBSCRIBE_MOCK_STREAM)
            await waitForEvent(wsClient, 'open')
            const payloadPromise = waitForEvent(wsClient, 'message')
            const onMessageCallback = (streamrClient.subscribe as any).mock.calls[0][1]
            onMessageCallback(MOCK_MESSAGE)
            const firstPayload = (await payloadPromise)[0] as string
            expect(JSON.parse(firstPayload)).toEqual(MOCK_MESSAGE)
        })

    })

})