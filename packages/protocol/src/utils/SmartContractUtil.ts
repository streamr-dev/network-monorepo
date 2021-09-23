import { Contract, ContractInterface, providers } from 'ethers'
import { ConnectionInfo } from 'ethers/lib/utils'

const { JsonRpcProvider } = providers

export type JSONRpcProviderConfig = string | ConnectionInfo

export type SmartContractConfig = {
    contractAddress: string
    jsonRpcProvider: JSONRpcProviderConfig
}

export async function initContract(config: SmartContractConfig, contractInterface: ContractInterface): Promise<Contract> {
    const { jsonRpcProvider, contractAddress } = config
    const provider = new JsonRpcProvider(jsonRpcProvider)
    // check that provider is connected and has some valid blockNumber
    await provider.getBlockNumber()

    const contract = new Contract(contractAddress, contractInterface, provider)
    // check that contract is connected
    await contract.addressPromise
    return contract
}

