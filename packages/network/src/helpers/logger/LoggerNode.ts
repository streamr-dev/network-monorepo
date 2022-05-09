import pino from 'pino'
import { LoggerCommon } from './LoggerCommon'

export class LoggerNode extends LoggerCommon {
    constructor(module: NodeJS.Module, context?: string, destinationStream?: { write(msg: string): void }) {
        const options: pino.LoggerOptions = {
            name: LoggerNode.createName(module, context),
            enabled: !process.env.NOLOG,
            level: process.env.LOG_LEVEL || 'info',
        }
        super(options, destinationStream)
    }
}

export { LoggerNode as Logger }
