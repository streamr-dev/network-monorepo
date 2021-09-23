import http from 'http'
import { startTracker, createNetworkNode, Tracker, NetworkNode } from 'streamr-network'
import { wait } from 'streamr-test-utils'
import { Wallet } from 'ethers'
import StreamrClient, { Stream } from 'streamr-client'
import { startBroker, createClient, StorageAssignmentEventManager, waitForStreamPersistedInStorageNode, createTestStream } from '../../../utils'
import { Broker } from "../../../../src/broker"

const httpPort1 = 12371
const wsPort1 = 12372
const trackerPort = 12375

const httpGet = (url: string): Promise<[number, string]> => { // return tuple is of form [statusCode, body]
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            res.setEncoding('utf8')
            let body = ''
            res.on('data', (chunk) => {
                body += chunk
            })
            res.on('end', () => resolve([res.statusCode ?? -1, body]))
        }).on('error', reject)
    })
}

const WAIT_TIME_TO_LAND_IN_STORAGE = 3000

describe('DataMetadataEndpoints', () => {
    let tracker: Tracker
    let storageNode: Broker
    let client1: StreamrClient
    let publisherNode: NetworkNode
    const storageNodeAccount = Wallet.createRandom()
    let assignmentEventManager: StorageAssignmentEventManager

    beforeAll(async () => {
        const engineAndEditorAccount = Wallet.createRandom()
        tracker = await startTracker({
            listen: {
                hostname: '127.0.0.1',
                port: trackerPort
            },
            id: 'tracker'
        })
        publisherNode = createNetworkNode({
            id: 'publisherNode',
            trackers: [tracker.getTrackerRecord()]
        })
        publisherNode.start()
        storageNode = await startBroker({
            name: 'storageNode',
            privateKey: storageNodeAccount.privateKey,
            trackerPort,
            httpPort: httpPort1,
            wsPort: wsPort1,
            enableCassandra: true,
            streamrAddress: engineAndEditorAccount.address,
            trackers: [tracker.getTrackerRecord()]
        })
        client1 = createClient(wsPort1)
        assignmentEventManager = new StorageAssignmentEventManager(wsPort1, engineAndEditorAccount)
        await assignmentEventManager.createStream()
    }, 10 * 1000)

    afterAll(async () => {
        await tracker.stop()
        await client1.ensureDisconnected()
        await publisherNode.stop()
        await storageNode.stop()
        await assignmentEventManager.close()
    })

    it('returns http error 400 if given non-numeric partition', async () => {
        const url = `http://localhost:${httpPort1}/api/v1/streams/stream/metadata/partitions/non-numeric`
        const [status, json] = await httpGet(url)
        const res = JSON.parse(json)

        expect(status).toEqual(400)
        expect(res).toEqual({
            error: 'Path parameter "partition" not a number: non-numeric'
        })
    })

    it('returns zero values for non-existing stream', async () => {
        const url = `http://localhost:${httpPort1}/api/v1/streams/non-existing-stream/metadata/partitions/0`
        const [status, json] = await httpGet(url)
        const res = JSON.parse(json)

        expect(status).toEqual(200)
        expect(res.totalBytes).toEqual(0)
        expect(res.totalMessages).toEqual(0)
        expect(res.firstMessage).toEqual(0)
        expect(res.lastMessage).toEqual(0)
    })

    async function setUpStream(): Promise<Stream> {
        const freshStream = await createTestStream(client1, module)
        await assignmentEventManager.addStreamToStorageNode(freshStream.id, storageNodeAccount.address, client1)
        await waitForStreamPersistedInStorageNode(freshStream.id, 0, '127.0.0.1', httpPort1)
        return freshStream
    }

    it('returns (non-zero) metadata for existing stream', async () => {
        const stream = await setUpStream()
        await client1.publish(stream.id, {
            key: 1
        })
        await client1.publish(stream.id, {
            key: 2
        })
        await client1.publish(stream.id, {
            key: 3
        })
        await client1.publish(stream.id, {
            key: 4
        })

        await wait(WAIT_TIME_TO_LAND_IN_STORAGE)

        const url = `http://localhost:${httpPort1}/api/v1/streams/${encodeURIComponent(stream.id)}/metadata/partitions/0`
        const [status, json] = await httpGet(url)
        const res = JSON.parse(json)

        expect(status).toEqual(200)
        expect(res.totalBytes).toEqual(1443)
        expect(res.totalMessages).toEqual(4)
        expect(
            new Date(res.firstMessage).getTime()
        ).toBeLessThan(
            new Date(res.lastMessage).getTime()
        )
    })
})
