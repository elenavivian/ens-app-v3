import type { Result } from '@ethersproject/abi'
import { defaultAbiCoder } from '@ethersproject/abi'
import { hexStripZeros } from '@ethersproject/bytes'
import { ENSArgs } from '..'
import { labelhash } from '../utils/labels'
import { namehash as makeNamehash } from '../utils/normalise'
import { checkIsDotEth } from '../utils/validation'
import { GraphMeta, returnOrThrow } from '../utils/errors'

export type Owner = {
  registrant?: string
  owner?: string
  ownershipLevel: 'nameWrapper' | 'registry' | 'registrar'
  expired?: boolean
}

type GetOwnerOptions = {
  contract?: 'nameWrapper' | 'registry' | 'registrar'
  skipGraph?: boolean
}

const singleContractOwnerRaw = async (
  { contracts }: ENSArgs<'contracts'>,
  contract: 'nameWrapper' | 'registry' | 'registrar',
  namehash: string,
  labels: string[],
) => {
  switch (contract) {
    case 'nameWrapper': {
      const nameWrapper = await contracts?.getNameWrapper()!

      return {
        to: nameWrapper.address,
        data: nameWrapper.interface.encodeFunctionData('ownerOf', [namehash]),
      }
    }
    case 'registry': {
      const registry = await contracts?.getRegistry()!

      return {
        to: registry.address,
        data: registry.interface.encodeFunctionData('owner', [namehash]),
      }
    }
    case 'registrar': {
      const registrar = await contracts?.getBaseRegistrar()!

      return {
        to: registrar.address,
        data: registrar.interface.encodeFunctionData('ownerOf', [
          labelhash(labels[0]),
        ]),
      }
    }
    // no default
  }
}

const raw = async (
  { contracts, multicallWrapper }: ENSArgs<'contracts' | 'multicallWrapper'>,
  name: string,
  options: GetOwnerOptions = {},
) => {
  const { contract } = options

  const namehash = makeNamehash(name)
  const labels = name.split('.')

  if (contract || labels.length === 1) {
    return singleContractOwnerRaw(
      { contracts },
      contract || 'registry',
      namehash,
      labels,
    )
  }

  const registryData = await singleContractOwnerRaw(
    { contracts },
    'registry',
    namehash,
    labels,
  )
  const nameWrapperData = await singleContractOwnerRaw(
    { contracts },
    'nameWrapper',
    namehash,
    labels,
  )
  const registrarData = await singleContractOwnerRaw(
    { contracts },
    'registrar',
    namehash,
    labels,
  )

  const data: { to: string; data: string }[] = [registryData, nameWrapperData]

  if (checkIsDotEth(labels)) {
    data.push(registrarData)
  }

  return multicallWrapper.raw(data)
}

const registrantQuery = `
  query GetRegistrant($namehash: String!) {
    domain(id: $namehash) {
      registration {
        registrant {
          id
        }
      }
    }
  }
`

const singleContractOwnerDecode = (data: string) =>
  defaultAbiCoder.decode(['address'], data)[0]

const decode = async (
  {
    contracts,
    multicallWrapper,
    gqlInstance,
    provider,
  }: ENSArgs<'contracts' | 'multicallWrapper' | 'gqlInstance' | 'provider'>,
  data: string,
  name: string,
  options: GetOwnerOptions = {},
): Promise<Owner | undefined> => {
  if (!data) return

  const { contract, skipGraph = true } = options

  const labels = name.split('.')
  const isEth = labels[labels.length - 1] === 'eth'
  const is2LD = labels.length === 2
  // const is2LDEth = isEth && is2LD

  if (contract || labels.length === 1) {
    const singleOwner = singleContractOwnerDecode(data)
    const obj = {
      ownershipLevel: contract || 'registry',
    }
    if (contract === 'registrar') {
      return {
        ...obj,
        registrant: singleOwner as string,
      }
    }
    return {
      ...obj,
      owner: singleOwner as string,
    }
  }
  const result = await multicallWrapper.decode(data)
  if (!result) return
  const nameWrapper = await contracts?.getNameWrapper()!

  const decodedData = [result[0][1], result[1][1], result[2]?.[1]].map(
    (ret) => ret && ret !== '0x' && defaultAbiCoder.decode(['address'], ret),
  )

  const registryOwner = (decodedData[0] as Result)[0]
  const nameWrapperOwner = (decodedData[1] as Result)[0]
  let registrarOwner: string | undefined = (
    decodedData[2] as Result | undefined
  )?.[0]
  let baseReturnObject: {
    expired?: boolean
  } = {}

  // check for only .eth names
  if (isEth) {
    let meta: GraphMeta | undefined

    // if there is no registrar owner, the name is expired
    // but we still want to get the registrar owner prior to expiry
    if (is2LD) {
      if (!registrarOwner && !skipGraph) {
        const graphRegistrantResult = await gqlInstance.client.request(
          registrantQuery,
          {
            namehash: makeNamehash(name),
          },
        )
        registrarOwner =
          graphRegistrantResult.domain?.registration?.registrant?.id
        baseReturnObject = {
          expired: true,
        }
        meta = graphRegistrantResult._meta
      } else {
        baseReturnObject = {
          expired: !registrarOwner,
        }
      }
    }

    if (
      baseReturnObject.expired &&
      registryOwner?.toLowerCase() === nameWrapper.address.toLowerCase()
    ) {
      return returnOrThrow<Owner>(
        {
          owner: nameWrapperOwner,
          ownershipLevel: 'nameWrapper',
          ...baseReturnObject,
        },
        meta,
        provider,
      )
    }

    // if the owner on the registrar is the namewrapper, then the namewrapper owner is the owner
    // there is no "registrant" for wrapped names.
    if (registrarOwner?.toLowerCase() === nameWrapper.address.toLowerCase()) {
      return returnOrThrow<Owner>(
        {
          owner: nameWrapperOwner,
          ownershipLevel: 'nameWrapper',
          ...baseReturnObject,
        },
        meta,
        provider,
      )
    }
    // if there is a registrar owner, then it's not a subdomain but we have also passed the namewrapper clause
    // this means that it's an unwrapped second-level name
    // the registrant is the owner of the NFT
    // the owner is the controller of the records
    if (registrarOwner) {
      return returnOrThrow<Owner>(
        {
          registrant: registrarOwner,
          owner: registryOwner,
          ownershipLevel: 'registrar',
          ...baseReturnObject,
        },
        meta,
        provider,
      )
    }
    if (hexStripZeros(registryOwner) !== '0x') {
      // if there is no registrar owner, but the label length is two, then the domain is an expired 2LD .eth
      // so we still want to return the ownership values
      if (labels.length === 2) {
        return returnOrThrow<Owner>(
          {
            registrant: undefined,
            owner: registryOwner,
            ownershipLevel: 'registrar',
            expired: true,
          },
          meta,
          provider,
        )
      }
      // this means that the subname is wrapped
      if (
        registryOwner === nameWrapper.address &&
        nameWrapperOwner &&
        hexStripZeros(nameWrapperOwner) !== '0x'
      ) {
        return returnOrThrow<Owner>(
          {
            owner: nameWrapperOwner,
            ownershipLevel: 'nameWrapper',
          },
          meta,
          provider,
        )
      }
      // unwrapped subnames do not have NFTs associated, so do not have a registrant
      return returnOrThrow<Owner>(
        {
          owner: registryOwner,
          ownershipLevel: 'registry',
        },
        meta,
        provider,
      )
    }
    // .eth names with no registrar owner are either unregistered or expired
    return returnOrThrow(undefined, meta, provider)
  }

  // non .eth names inherit the owner from the registry
  // there will only ever be an owner for non .eth names, not a registrant
  // this is because for unwrapped names, there is no associated NFT
  // and for wrapped names, owner and registrant are the same thing
  if (
    registryOwner === nameWrapper.address &&
    nameWrapperOwner &&
    hexStripZeros(nameWrapperOwner) !== '0x'
  ) {
    return {
      owner: nameWrapperOwner,
      ownershipLevel: 'nameWrapper',
    }
  }

  // for unwrapped non .eth names, the owner is the registry owner
  if (hexStripZeros(registryOwner) !== '0x') {
    return {
      owner: registryOwner,
      ownershipLevel: 'registry',
    }
  }

  // for anything else, return
  return
}
export default { raw, decode }
