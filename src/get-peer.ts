import { peerIdFromString } from '@libp2p/peer-id'
import { Multiaddr } from '@multiformats/multiaddr'
import errCode from 'err-code'
import { codes } from './errors.js'
import { isPeerId } from '@libp2p/interfaces/peer-id'
import type { PeerId } from '@libp2p/interfaces/peer-id'
import type { PeerInfo } from '@libp2p/interfaces/peer-info'

function peerIdFromMultiaddr (ma: Multiaddr) {
  const idStr = ma.getPeerId()

  if (idStr == null) {
    throw errCode(
      new Error(`${ma.toString()} does not have a valid peer type`),
      codes.ERR_INVALID_MULTIADDR
    )
  }

  try {
    return peerIdFromString(idStr)
  } catch (err: any) {
    throw errCode(
      new Error(`${ma.toString()} is not a valid peer type`),
      codes.ERR_INVALID_MULTIADDR
    )
  }
}

/**
 * Converts the given `peer` to a `Peer` object.
 */
export function getPeer (peer: PeerId | Multiaddr | string): PeerInfo {
  if (isPeerId(peer)) {
    return {
      id: peer,
      multiaddrs: [],
      protocols: []
    }
  }

  if (typeof peer === 'string') {
    peer = new Multiaddr(peer)
  }

  let addr

  if (Multiaddr.isMultiaddr(peer)) {
    addr = peer
    peer = peerIdFromMultiaddr(peer)
  }

  return {
    id: peer,
    multiaddrs: addr != null ? [addr] : [],
    protocols: []
  }
}
