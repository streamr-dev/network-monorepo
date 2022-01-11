import qs from 'qs'
import split2 from 'split2'
import fetch from 'node-fetch'
import { StreamMessage, ControlMessage, ResendLastRequest, ResendFromRequest, ResendRangeRequest } from 'streamr-client-protocol'
import AbortController from 'abort-controller'
import { MAX_SEQUENCE_NUMBER_VALUE, MIN_SEQUENCE_NUMBER_VALUE } from '../storage/DataQueryEndpoints'
import { GenericError } from '../../errors/GenericError'
import { formAuthorizationHeader } from '../../helpers/authentication'
import { Logger } from "streamr-network"
import { StreamrClient } from "streamr-client"

export interface HistoricalDataResponse {
    data: NodeJS.ReadableStream
    abort: () => void
    startTime: number
}

const logger = new Logger(module)

const getDataQueryEndpointUrl = (request: ResendFromRequest|ResendLastRequest|ResendRangeRequest, baseUrl: string) => {
    const createUrl = (endpointSuffix: string, query: any) => {
        const queryParameters = qs.stringify({
            ...query,
            format: 'raw'
        }, { skipNulls: true })
        // eslint-disable-next-line max-len
        return `${baseUrl}/streams/${encodeURIComponent(request.streamId)}/data/partitions/${request.streamPartition}/${endpointSuffix}?${queryParameters}`
    }
    let r
    switch (request.type) {
        case ControlMessage.TYPES.ResendLastRequest:
            r = request as ResendLastRequest
            return createUrl('last', {
                count: r.numberLast
            })
        case ControlMessage.TYPES.ResendFromRequest:
            r = request as ResendFromRequest
            return createUrl('from', {
                fromTimestamp: r.fromMsgRef.timestamp,
                // TODO client should provide sequenceNumber, remove MIN_SEQUENCE_NUMBER_VALUE defaults when NET-267
                //  have been implemented
                fromSequenceNumber: r.fromMsgRef.sequenceNumber ?? MIN_SEQUENCE_NUMBER_VALUE,
                publisherId: r.publisherId,
            })
        case ControlMessage.TYPES.ResendRangeRequest:
            r = request as ResendRangeRequest
            return createUrl('range', {
                fromTimestamp: r.fromMsgRef.timestamp,
                // TODO client should provide sequenceNumber, remove MIN_SEQUENCE_NUMBER_VALUE&MAX_SEQUENCE_NUMBER_VALUE
                // defaults when NET-267 have been implemented
                fromSequenceNumber: r.fromMsgRef.sequenceNumber ?? MIN_SEQUENCE_NUMBER_VALUE,
                toTimestamp: r.toMsgRef.timestamp,
                toSequenceNumber: r.toMsgRef.sequenceNumber ?? MAX_SEQUENCE_NUMBER_VALUE,
                publisherId: r.publisherId,
                msgChainId: r.msgChainId
            })
        default:
            throw new Error('Assertion failed: request.type=' + request.type)
    }
}

export const createResponse = async (
    request: ResendFromRequest|ResendLastRequest|ResendRangeRequest,
    client: StreamrClient
): Promise<HistoricalDataResponse> => {
    const stream = await client.getStream(request.streamId)
    const storageNodeAddresses = await stream.getStorageNodes()
    const storageNodeUrls = storageNodeAddresses.map(async (nodeAddress) => {
        await client.getStorageNodeUrl(nodeAddress)
    })

    // Form data query endpoints and shuffle the resulting array
    const urls = storageNodeUrls.map((storageNodeUrl) => {
        return getDataQueryEndpointUrl(request, `${storageNodeUrl}/api/v1`)
    }).sort(() => Math.random() - 0.5) // shuffle

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i]
        const abortController = new AbortController()
        const headers = formAuthorizationHeader(request.sessionToken)
        const response = await fetch(url, {
            headers,
            signal: abortController.signal
        })
        if (response.status === 200) {
            const data = response.body.pipe(split2((message: string) => StreamMessage.deserialize(message)))
            return {
                data,
                abort: () => {
                    data.destroy()
                    abortController.abort()
                },
                startTime: Date.now()
            }
        } else {
            logger.debug(`Storage node fetch error: ${response.status} ${url}`)
        }
    }
    return Promise.reject(
        new GenericError(
            `Storage node fetch error: Failed to fetch historical data from all storage nodes`,
            'STORAGE_NODE_FETCH_ERROR'
        )
    )
}