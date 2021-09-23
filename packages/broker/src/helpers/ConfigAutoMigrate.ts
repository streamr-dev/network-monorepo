import { TrackerRecord } from 'streamr-network/dist/streamr-client-protocol'

import { Config } from '../config'
import fs from 'fs'
import path from 'path'
import { validateConfig } from './validateConfig'
import schema from './config.schema.json'
import schemaTestnet1 from '../plugins/testnetMiner/config.schema.testnet1.json'
import schemaTestnet2 from '../plugins/testnetMiner/config.schema.json'

const TESTNET2_TRACKER_REGISTRY = [
    {
        "id": "0xFBB6066c44bc8132bA794C73f58F391273E3bdA1",
        "ws": "wss://testnet3.streamr.network:30401",
        "http": "https://testnet3.streamr.network:30401"
    },
    {
        "id": "0x3D61bFeFA09CEAC1AFceAA50c7d79BE409E1ec24",
        "ws": "wss://testnet3.streamr.network:30402",
        "http": "https://testnet3.streamr.network:30402"
    },
    {
        "id": "0xE80FB5322231cBC1e761A0F896Da8E0CA2952A66",
        "ws": "wss://testnet3.streamr.network:30403",
        "http": "https://testnet3.streamr.network:30403"
    },
    {
        "id": "0xf626285C6AACDE39ae969B9Be90b1D9855F186e0",
        "ws": "wss://testnet3.streamr.network:30404",
        "http": "https://testnet3.streamr.network:30404"
    },
    {
        "id": "0xce88Da7FE0165C8b8586aA0c7C4B26d880068219",
        "ws": "wss://testnet3.streamr.network:30405",
        "http": "https://testnet3.streamr.network:30405"
    },
    {
        "id": "0x05e7a0A64f88F84fB1945a225eE48fFC2c48C38E",
        "ws": "wss://testnet4.streamr.network:30401",
        "http": "https://testnet4.streamr.network:30401"
    },
    {
        "id": "0xF15784106ACd35b0542309CDF2b35cb5BA642C4F",
        "ws": "wss://testnet4.streamr.network:30402",
        "http": "https://testnet4.streamr.network:30402"
    },
    {
        "id": "0x77FA7Af34108abdf8e92B8f4C4AeC7CbfD1d6B09",
        "ws": "wss://testnet4.streamr.network:30403",
        "http": "https://testnet4.streamr.network:30403"
    },
    {
        "id": "0x7E83e0bdAF1eF06F31A02f35A07aFB48179E536B",
        "ws": "wss://testnet4.streamr.network:30404",
        "http": "https://testnet4.streamr.network:30404"
    },
    {
        "id": "0x2EeF37180691c75858Bf1e781D13ae96943Dd388",
        "ws": "wss://testnet4.streamr.network:30405",
        "http": "https://testnet4.streamr.network:30405"
    }
]

const TESTNET2_STREAM_IDS = [
    'streamr.eth/brubeck-testnet/rewards/5hhb49',
    'streamr.eth/brubeck-testnet/rewards/95hc37',
    'streamr.eth/brubeck-testnet/rewards/12ab22',
    'streamr.eth/brubeck-testnet/rewards/z15g13',
    'streamr.eth/brubeck-testnet/rewards/111249',
    'streamr.eth/brubeck-testnet/rewards/0g2jha',
    'streamr.eth/brubeck-testnet/rewards/fijka2',
    'streamr.eth/brubeck-testnet/rewards/91ab49',
    'streamr.eth/brubeck-testnet/rewards/giab22',
    'streamr.eth/brubeck-testnet/rewards/25kpf4'
]

const migrateTrackerRegistry = (trackerRegistry: TrackerRecord[]): TrackerRecord[] => {
    if (trackerRegistry.length === 1) {
        return TESTNET2_TRACKER_REGISTRY
    } else {
        return trackerRegistry
    }
}

export const testnet2AutoMigrate = (config: any, configFilePath: string): Config => {
    // Skip auto-migration if testnetMiner plugin not enabled
    if (config.plugins.testnetMiner === undefined) {
        return config
    }
    const backup = JSON.stringify(config, null, 2)
    try {
        validateConfig(config.plugins.testnetMiner, schemaTestnet2)
        return config
    } catch (err) {
        try {
            console.info('Migrating testnet1 config to testnet2 config')
            validateConfig(config, schema)

            if (config.plugins.testnetMiner.rewardStreamIds) {
                delete config.plugins.testnetMiner.rewardStreamIds
            }
            validateConfig(config.plugins.testnetMiner, schemaTestnet1)

            const directory = path.dirname(configFilePath)
            const oldFileName = path.basename(configFilePath)
            const backupFilePath = path.join(directory, `testnet1-backup-${oldFileName}`)
            console.info('Backing up testnet1 config to ' + backupFilePath)
            fs.writeFileSync(backupFilePath, backup)

            config['network']['trackers'] = migrateTrackerRegistry(config['network']['trackers'] as TrackerRecord[])
            delete config['plugins']['testnetMiner']['rewardStreamId']
            config['plugins']['testnetMiner']['rewardStreamIds'] = TESTNET2_STREAM_IDS
            validateConfig(config.plugins.testnetMiner, schemaTestnet2)

            console.info('Updating config file at ' + configFilePath)
            fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2))
            return config
        } catch (err) {
            console.warn('Testnet1 -> Testnet2 configuration migration failed', err)
            return config
        }
    }
}
