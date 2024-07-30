import { QueryFunctionContext } from '@tanstack/react-query'

import { CoinName, coinNameToTypeMap } from '@ensdomains/address-encoder'
import { isEvmCoinType } from '@ensdomains/address-encoder/utils'

import { SupportedAddress, supportedAddresses } from '@app/constants/supportedAddresses'
import { useQueryOptions } from '@app/hooks/useQueryOptions'
import { CreateQueryKey, QueryConfig } from '@app/types'
import { getIsCachedData } from '@app/utils/getIsCachedData'
import { prepareQueryOptions } from '@app/utils/prepareQueryOptions'
import { useQuery } from '@app/utils/query/useQuery'

type UseCoinChainParameters = {
  coinName?: string
}

type CoinBlockExplorer = {
  name: string
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
  blockExplorers: {
    default: {
      name: string
      url: string
      apiUrl?: string
    }
  }
}

type UseCoinChainReturnType = {
  error: boolean
  data: CoinBlockExplorer | null
}

type UseCoinChainConfig = QueryConfig<UseCoinChainReturnType, Error>

type QueryKey<TParams extends UseCoinChainParameters> = CreateQueryKey<
  TParams,
  'getCoinChain',
  'independent'
>

export const getCoinChainQueryFn = async <TParams extends UseCoinChainParameters>({
  queryKey: [{ coinName }],
}: QueryFunctionContext<QueryKey<TParams>>): Promise<UseCoinChainReturnType> => {
  if (!coinName) throw new Error('name is required')

  const lowerCoinName = coinName?.toLowerCase() || ''

  if (supportedAddresses.includes(coinName?.toLowerCase() as SupportedAddress)) {
    const supportedBlockExplorers = await import('../../constants/blockExplorers/supported.json')
    const coinBlockExplorer = supportedBlockExplorers?.default.find(
      (blockExplorer) =>
        blockExplorer?.nativeCurrency?.symbol.toLowerCase() === lowerCoinName ||
        blockExplorer?.name?.toLocaleLowerCase() === lowerCoinName,
      // Also need to check the name since currency symbol doesn't necessarily equal to the coin name (Ex. zora)
    )
    return { error: false, data: coinBlockExplorer as CoinBlockExplorer }
  }

  if (isEvmCoinType(coinNameToTypeMap[coinName as CoinName])) {
    const evmBlockExplorers = await import('../../constants/blockExplorers/evm.json')
    const coinBlockExplorer = evmBlockExplorers?.default.find(
      (blockExplorer) =>
        blockExplorer?.nativeCurrency?.symbol.toLowerCase() === lowerCoinName ||
        blockExplorer?.name?.toLocaleLowerCase() === lowerCoinName,
      // Also need to check the name since currency symbol doesn't necessarily equal to the coin name (Ex. zora)
    )
    return { error: false, data: coinBlockExplorer as CoinBlockExplorer }
  }

  return { error: false, data: null }
}

export const useCoinChain = <TParams extends UseCoinChainParameters>({
  enabled = true,
  gcTime,
  staleTime,
  scopeKey,
  ...params
}: TParams & UseCoinChainConfig) => {
  const initialOptions = useQueryOptions({
    params,
    scopeKey,
    functionName: 'getCoinChain',
    queryDependencyType: 'independent',
    queryFn: getCoinChainQueryFn,
  })

  const preparedOptions = prepareQueryOptions({
    queryKey: initialOptions.queryKey,
    queryFn: initialOptions.queryFn,
    enabled: enabled && !!params.coinName,
    gcTime,
    staleTime,
  })

  const query = useQuery(preparedOptions)

  return {
    ...query,
    refetchIfEnabled: preparedOptions.enabled ? query.refetch : () => {},
    isCachedData: getIsCachedData(query),
  }
}
