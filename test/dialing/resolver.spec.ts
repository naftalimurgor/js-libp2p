/* eslint-env mocha */

import { expect } from 'aegir/utils/chai.js'
import sinon from 'sinon'
import { Multiaddr } from '@multiformats/multiaddr'
import { codes as ErrorCodes } from '../../src/errors.js'
import { createNode } from '../utils/creators/peer.js'
import { createBaseOptions } from '../utils/base-options.browser.js'
import { MULTIADDRS_WEBSOCKETS } from '../fixtures/browser.js'
import type { PeerId } from '@libp2p/interfaces/peer-id'
import type { Libp2pNode } from '../../src/libp2p.js'
import { Circuit } from '../../src/circuit/transport.js'
import pDefer from 'p-defer'
import { mockConnection, mockDuplex, mockMultiaddrConnection } from '@libp2p/interface-compliance-tests/mocks'
import { peerIdFromString } from '@libp2p/peer-id'
import { WebSockets } from '@libp2p/websockets'

const relayAddr = MULTIADDRS_WEBSOCKETS[0]

const getDnsaddrStub = (peerId: PeerId) => [
  `/dnsaddr/ams-1.bootstrap.libp2p.io/p2p/${peerId.toString()}`,
  `/dnsaddr/ams-2.bootstrap.libp2p.io/p2p/${peerId.toString()}`,
  `/dnsaddr/lon-1.bootstrap.libp2p.io/p2p/${peerId.toString()}`,
  `/dnsaddr/nrt-1.bootstrap.libp2p.io/p2p/${peerId.toString()}`,
  `/dnsaddr/nyc-1.bootstrap.libp2p.io/p2p/${peerId.toString()}`,
  `/dnsaddr/sfo-2.bootstrap.libp2p.io/p2p/${peerId.toString()}`
]

const relayedAddr = (peerId: PeerId) => `${relayAddr.toString()}/p2p-circuit/p2p/${peerId.toString()}`

const getDnsRelayedAddrStub = (peerId: PeerId) => [
  `${relayedAddr(peerId)}`
]

describe('Dialing (resolvable addresses)', () => {
  let libp2p: Libp2pNode, remoteLibp2p: Libp2pNode
  let resolver: sinon.SinonStub<[Multiaddr], Promise<string[]>>

  beforeEach(async () => {
    resolver = sinon.stub<[Multiaddr], Promise<string[]>>();

    [libp2p, remoteLibp2p] = await Promise.all([
      createNode({
        config: createBaseOptions({
          addresses: {
            listen: [`${relayAddr.toString()}/p2p-circuit`]
          },
          connectionManager: {
            autoDial: false
          },
          relay: {
            enabled: true,
            hop: {
              enabled: false
            }
          },
          dialer: {
            resolvers: {
              dnsaddr: resolver
            }
          }
        }),
        started: true
      }),
      createNode({
        config: createBaseOptions({
          addresses: {
            listen: [`${relayAddr.toString()}/p2p-circuit`]
          },
          connectionManager: {
            autoDial: false
          },
          relay: {
            enabled: true,
            hop: {
              enabled: false
            }
          },
          dialer: {
            resolvers: {
              dnsaddr: resolver
            }
          }
        }),
        started: true
      })
    ])
  })

  afterEach(async () => {
    sinon.restore()
    await Promise.all([libp2p, remoteLibp2p].map(async n => await n.stop()))
  })

  it('resolves dnsaddr to ws local address', async () => {
    const remoteId = remoteLibp2p.peerId
    const dialAddr = new Multiaddr(`/dnsaddr/remote.libp2p.io/p2p/${remoteId.toString()}`)
    const relayedAddrFetched = new Multiaddr(relayedAddr(remoteId))

    // Transport spy
    const transport = getTransport(libp2p, Circuit.prototype[Symbol.toStringTag])
    const transportDialSpy = sinon.spy(transport, 'dial')

    // Resolver stub
    resolver.onCall(0).returns(Promise.resolve(getDnsRelayedAddrStub(remoteId)))

    // Dial with address resolve
    const connection = await libp2p.dial(dialAddr)
    expect(connection).to.exist()
    expect(connection.remoteAddr.equals(relayedAddrFetched))

    const dialArgs = transportDialSpy.firstCall.args
    expect(dialArgs[0].equals(relayedAddrFetched)).to.eql(true)
  })

  it('resolves a dnsaddr recursively', async () => {
    const remoteId = remoteLibp2p.peerId
    const dialAddr = new Multiaddr(`/dnsaddr/remote.libp2p.io/p2p/${remoteId.toString()}`)
    const relayedAddrFetched = new Multiaddr(relayedAddr(remoteId))

    // Transport spy
    const transport = getTransport(libp2p, Circuit.prototype[Symbol.toStringTag])
    const transportDialSpy = sinon.spy(transport, 'dial')

    // Resolver stub
    let firstCall = false
    resolver.callsFake(async () => {
      if (!firstCall) {
        firstCall = true
        // Return an array of dnsaddr
        return await Promise.resolve(getDnsaddrStub(remoteId))
      }
      return await Promise.resolve(getDnsRelayedAddrStub(remoteId))
    })

    // Dial with address resolve
    const connection = await libp2p.dial(dialAddr)
    expect(connection).to.exist()
    expect(connection.remoteAddr.equals(relayedAddrFetched))

    const dialArgs = transportDialSpy.firstCall.args
    expect(dialArgs[0].equals(relayedAddrFetched)).to.eql(true)
  })

  // TODO: Temporary solution does not resolve dns4/dns6
  // Resolver just returns the received multiaddrs
  it('stops recursive resolve if finds dns4/dns6 and dials it', async () => {
    const remoteId = remoteLibp2p.peerId
    const dialAddr = new Multiaddr(`/dnsaddr/remote.libp2p.io/p2p/${remoteId.toString()}`)

    // Stub resolver
    const dnsMa = new Multiaddr(`/dns4/ams-1.remote.libp2p.io/tcp/443/wss/p2p/${remoteId.toString()}`)
    resolver.returns(Promise.resolve([
      `${dnsMa.toString()}`
    ]))

    const deferred = pDefer()

    // Stub transport
    const transport = getTransport(libp2p, WebSockets.prototype[Symbol.toStringTag])
    const stubTransport = sinon.stub(transport, 'dial')
    stubTransport.callsFake(async (multiaddr) => {
      expect(multiaddr.equals(dnsMa)).to.equal(true)

      deferred.resolve()

      return mockConnection(mockMultiaddrConnection(mockDuplex(), peerIdFromString(multiaddr.getPeerId() ?? '')))
    })

    void libp2p.dial(dialAddr)

    await deferred.promise
  })

  it('resolves a dnsaddr recursively not failing if one address fails to resolve', async () => {
    const remoteId = remoteLibp2p.peerId
    const dialAddr = new Multiaddr(`/dnsaddr/remote.libp2p.io/p2p/${remoteId.toString()}`)
    const relayedAddrFetched = new Multiaddr(relayedAddr(remoteId))

    // Transport spy
    const transport = getTransport(libp2p, Circuit.prototype[Symbol.toStringTag])
    const transportDialSpy = sinon.spy(transport, 'dial')

    // Resolver stub
    resolver.onCall(0).callsFake(async () => await Promise.resolve(getDnsaddrStub(remoteId)))
    resolver.onCall(1).callsFake(async () => await Promise.reject(new Error()))
    resolver.callsFake(async () => await Promise.resolve(getDnsRelayedAddrStub(remoteId)))

    // Dial with address resolve
    const connection = await libp2p.dial(dialAddr)
    expect(connection).to.exist()
    expect(connection.remoteAddr.equals(relayedAddrFetched))

    const dialArgs = transportDialSpy.firstCall.args
    expect(dialArgs[0].equals(relayedAddrFetched)).to.eql(true)
  })

  it('fails to dial if resolve fails and there are no addresses to dial', async () => {
    const remoteId = remoteLibp2p.peerId
    const dialAddr = new Multiaddr(`/dnsaddr/remote.libp2p.io/p2p/${remoteId.toString()}`)

    // Stub resolver
    resolver.returns(Promise.reject(new Error()))

    // Stub transport
    const transport = getTransport(libp2p, WebSockets.prototype[Symbol.toStringTag])
    const spy = sinon.spy(transport, 'dial')

    await expect(libp2p.dial(dialAddr))
      .to.eventually.be.rejectedWith(Error)
      .and.to.have.nested.property('.code', ErrorCodes.ERR_NO_VALID_ADDRESSES)
    expect(spy.callCount).to.eql(0)
  })
})

function getTransport (libp2p: Libp2pNode, tag: string) {
  const transport = libp2p.components.getTransportManager().getTransports().find(t => {
    return t[Symbol.toStringTag] === tag
  })

  if (transport != null) {
    return transport
  }

  throw new Error(`No transport found for ${tag}`)
}
