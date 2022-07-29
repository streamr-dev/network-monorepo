import UnsupportedVersionError from '../../errors/UnsupportedVersionError'
import UnsupportedTypeError from '../../errors/UnsupportedTypeError'
import { validateIsInteger, validateIsString } from '../../utils/validations'
import { Serializer } from '../../Serializer'

// TODO use ControlMessageType instead of number when we have real enums
const serializerByVersionAndType: Record<string, Record<number, Serializer<ControlMessage>>> = {}
const LATEST_VERSION = 2

export enum ControlMessageType {
    BroadcastMessage = 0,
    ErrorResponse = 7,
    UnsubscribeRequest = 10,
    ProxyConnectionRequest = 14,
    ProxyConnectionResponse = 15,
    ReceiptRequest = 16,
    ReceiptResponse = 17
}

export interface ControlMessageOptions {
    version?: number
    requestId: string
}

export default class ControlMessage {

    static LATEST_VERSION = LATEST_VERSION

    static TYPES = ControlMessageType  // TODO can we remove this and use the enum object directly?

    version: number
    type: ControlMessageType
    requestId: string

    // eslint-disable-next-line @typescript-eslint/default-param-last
    constructor(version = LATEST_VERSION, type: ControlMessageType, requestId: string) {
        if (new.target === ControlMessage) {
            throw new TypeError('ControlMessage is abstract.')
        }
        validateIsInteger('version', version)
        this.version = version
        validateIsInteger('type', type)
        this.type = type

        // Since V2 - allow null in older versions
        validateIsString('requestId', requestId, version < 2)
        this.requestId = requestId
    }

    static registerSerializer(version: number, type: ControlMessageType, serializer: Serializer<ControlMessage>): void {
        // Check the serializer interface
        if (!serializer.fromArray) {
            throw new Error(`Serializer ${JSON.stringify(serializer)} doesn't implement a method fromArray!`)
        }
        if (!serializer.toArray) {
            throw new Error(`Serializer ${JSON.stringify(serializer)} doesn't implement a method toArray!`)
        }

        if (serializerByVersionAndType[version] === undefined) {
            serializerByVersionAndType[version] = {}
        }
        if (serializerByVersionAndType[version][type] !== undefined) {
            throw new Error(`Serializer for version ${version} and type ${type} is already registered: ${
                JSON.stringify(serializerByVersionAndType[version][type])
            }`)
        }
        serializerByVersionAndType[version][type] = serializer
    }

    static unregisterSerializer(version: number, type: ControlMessageType): void {
        delete serializerByVersionAndType[version][type]
    }

    static getSerializer(version: number, type: ControlMessageType): Serializer<ControlMessage> {
        const serializersByType = serializerByVersionAndType[version]
        if (!serializersByType) {
            throw new UnsupportedVersionError(version, `Supported versions: [${ControlMessage.getSupportedVersions()}]`)
        }
        const clazz = serializersByType[type]
        if (!clazz) {
            throw new UnsupportedTypeError(type, `Supported types: [${Object.keys(serializersByType)}]`)
        }
        return clazz
    }

    static getSupportedVersions(): number[] {
        return Object.keys(serializerByVersionAndType).map((key) => parseInt(key, 10))
    }

    serialize(version = this.version, ...typeSpecificSerializeArgs: any[]): string {
        return JSON.stringify(ControlMessage.getSerializer(version, this.type).toArray(this, ...typeSpecificSerializeArgs))
    }

    /**
     * Takes a serialized representation (array or string) of a message, and returns a ControlMessage instance.
     */
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    static deserialize(msg: any, ...typeSpecificDeserializeArgs: any[]): ControlMessage {
        const messageArray = (typeof msg === 'string' ? JSON.parse(msg) : msg)

        const messageVersion = messageArray[0]
        const messageType = messageArray[1]

        const C = ControlMessage.getSerializer(messageVersion, messageType)
        return C.fromArray(messageArray, ...typeSpecificDeserializeArgs)
    }
}
