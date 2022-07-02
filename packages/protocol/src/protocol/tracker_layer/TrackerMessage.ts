import UnsupportedVersionError from '../../errors/UnsupportedVersionError'
import UnsupportedTypeError from '../../errors/UnsupportedTypeError'
import { validateIsInteger, validateIsString } from '../../utils/validations'
import { Serializer } from '../../Serializer'

// TODO use ControlMessageType instead of number when we have real enums
const serializerByVersionAndType: {[version: string]: { [type: number]: Serializer<TrackerMessage> }} = {}
const LATEST_VERSION = 2

export enum TrackerMessageType {
    StatusMessage = 1,
    InstructionMessage = 2,
    RelayMessage = 5,
    ErrorMessage = 6,
    StatusAckMessage = 7
}

export interface TrackerMessageOptions {
    version?: number
    requestId: string
}

export default class TrackerMessage {

    static LATEST_VERSION = LATEST_VERSION

    static TYPES = TrackerMessageType // TODO can we remove this and use the enum object directly?

    version: number
    type: TrackerMessageType
    requestId: string

    constructor(version = LATEST_VERSION, type: TrackerMessageType, requestId: string) {
        if (new.target === TrackerMessage) {
            throw new TypeError('TrackerMessage is abstract.')
        }

        validateIsInteger('version', version)
        validateIsInteger('type', type)
        validateIsString('requestId', requestId)

        this.version = version
        this.type = type
        this.requestId = requestId
    }

    static registerSerializer(version: number, type: number, serializer: Serializer<TrackerMessage>): void {
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

    static unregisterSerializer(version: number, type: TrackerMessageType): void {
        delete serializerByVersionAndType[version][type]
    }

    static getSerializer(version: number, type: TrackerMessageType): Serializer<TrackerMessage> {
        const serializersByType = serializerByVersionAndType[version]
        if (!serializersByType) {
            throw new UnsupportedVersionError(version, `Supported versions: [${TrackerMessage.getSupportedVersions()}]`)
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
        return JSON.stringify(TrackerMessage.getSerializer(version, this.type).toArray(this, ...typeSpecificSerializeArgs))
    }

    /**
     * Takes a serialized representation (array or string) of a message, and returns a ControlMessage instance.
     */
    static deserialize(msg: any[] | string, ...typeSpecificDeserializeArgs: any[]): TrackerMessage {
        const messageArray = (typeof msg === 'string' ? JSON.parse(msg) : msg)

        const messageVersion = messageArray[0]
        const messageType = messageArray[1]

        const C = TrackerMessage.getSerializer(messageVersion, messageType)
        return C.fromArray(messageArray, ...typeSpecificDeserializeArgs)
    }
}

