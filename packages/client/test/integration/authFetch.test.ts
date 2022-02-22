jest.mock('node-fetch')

import fetch from 'node-fetch'
import { fastPrivateKey } from 'streamr-test-utils'

import { StreamrClient } from '../../src/StreamrClient'

import clientOptions from './config'

describe('authFetch', () => {
    let client: StreamrClient
    afterEach(async () => {
        if (!client) { return }
        await client.destroy()
    })

    afterAll(() => {
        jest.restoreAllMocks()
    })

    it('sends Streamr-Client header', async () => {
        const realFetch = jest.requireActual('node-fetch')
        // @ts-expect-error
        fetch.Response = realFetch.Response
        // @ts-expect-error
        fetch.Promise = realFetch.Promise
        // @ts-expect-error
        fetch.Request = realFetch.Request
        // @ts-expect-error
        fetch.Headers = realFetch.Headers
        // @ts-expect-error
        fetch.mockImplementation(realFetch)
        client = new StreamrClient({
            ...clientOptions,
            autoConnect: false,
            autoDisconnect: false,
            auth: {
                privateKey: fastPrivateKey()
            },
        })
        await client.connect()
        expect(fetch).not.toHaveBeenCalled() // will get called in background though (questionable behaviour)
        // @ts-expect-error
        await client.session.getSessionToken() // this ensures authentication completed
        expect(fetch).toHaveBeenCalled()
        // @ts-expect-error
        fetch.mock.calls.forEach(([url, opts]) => {
            expect(typeof url).toEqual('string')
            expect(opts).toMatchObject({
                headers: {
                    'Streamr-Client': expect.stringMatching('streamr-client-javascript'),
                },
            })
        })
    })
})
