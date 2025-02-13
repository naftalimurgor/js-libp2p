/* eslint-env mocha */

import { expect } from 'aegir/utils/chai.js'
import sinon from 'sinon'
import { Mplex } from '@libp2p/mplex'
import { Multiaddr } from '@multiformats/multiaddr'
import { pipe } from 'it-pipe'
import all from 'it-all'
import pSettle from 'p-settle'
import { WebSockets } from '@libp2p/websockets'
import { NOISE } from '@chainsafe/libp2p-noise'
import { PreSharedKeyConnectionProtector } from '../../src/pnet/index.js'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import swarmKey from '../fixtures/swarm.key.js'
import { DefaultUpgrader } from '../../src/upgrader.js'
import { codes } from '../../src/errors.js'
import { mockConnectionGater, mockMultiaddrConnPair, mockRegistrar } from '@libp2p/interface-compliance-tests/mocks'
import Peers from '../fixtures/peers.js'
import type { Upgrader } from '@libp2p/interfaces/transport'
import type { PeerId } from '@libp2p/interfaces/peer-id'
import { createFromJSON } from '@libp2p/peer-id-factory'
import { Components } from '@libp2p/interfaces/components'
import { Plaintext } from '../../src/insecure/index.js'
import type { ConnectionEncrypter, SecuredConnection } from '@libp2p/interfaces/connection-encrypter'
import type { StreamMuxer, StreamMuxerFactory, StreamMuxerInit } from '@libp2p/interfaces/stream-muxer'
import type { Stream } from '@libp2p/interfaces/connection'
import pDefer from 'p-defer'
import { createLibp2pNode, Libp2pNode } from '../../src/libp2p.js'

const addrs = [
  new Multiaddr('/ip4/127.0.0.1/tcp/0'),
  new Multiaddr('/ip4/127.0.0.1/tcp/0')
]

describe('Upgrader', () => {
  let localUpgrader: Upgrader
  let remoteUpgrader: Upgrader
  let localPeer: PeerId
  let remotePeer: PeerId
  let localComponents: Components
  let remoteComponents: Components

  beforeEach(async () => {
    ([
      localPeer,
      remotePeer
    ] = await Promise.all([
      createFromJSON(Peers[0]),
      createFromJSON(Peers[1])
    ]))

    localComponents = new Components({
      peerId: localPeer,
      connectionGater: mockConnectionGater(),
      registrar: mockRegistrar()
    })
    localUpgrader = new DefaultUpgrader(localComponents, {
      connectionEncryption: [
        new Plaintext()
      ],
      muxers: [
        new Mplex()
      ]
    })

    remoteComponents = new Components({
      peerId: remotePeer,
      connectionGater: mockConnectionGater(),
      registrar: mockRegistrar()
    })
    remoteUpgrader = new DefaultUpgrader(remoteComponents, {
      connectionEncryption: [
        new Plaintext()
      ],
      muxers: [
        new Mplex()
      ]
    })

    await localComponents.getRegistrar().handle('/echo/1.0.0', ({ stream }) => {
      void pipe(stream, stream)
    })
    await remoteComponents.getRegistrar().handle('/echo/1.0.0', ({ stream }) => {
      void pipe(stream, stream)
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should upgrade with valid muxers and crypto', async () => {
    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })

    const connections = await Promise.all([
      localUpgrader.upgradeOutbound(outbound),
      remoteUpgrader.upgradeInbound(inbound)
    ])

    expect(connections).to.have.length(2)

    const { stream, protocol } = await connections[0].newStream('/echo/1.0.0')
    expect(protocol).to.equal('/echo/1.0.0')

    const hello = uint8ArrayFromString('hello there!')
    const result = await pipe(
      [hello],
      stream,
      function toBuffer (source) {
        return (async function * () {
          for await (const val of source) yield val.slice()
        })()
      },
      async (source) => await all(source)
    )

    expect(result).to.eql([hello])
  })

  it('should upgrade with only crypto', async () => {
    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })

    // No available muxers
    localUpgrader = new DefaultUpgrader(localComponents, {
      connectionEncryption: [
        new Plaintext()
      ],
      muxers: []
    })
    remoteUpgrader = new DefaultUpgrader(remoteComponents, {
      connectionEncryption: [
        new Plaintext()
      ],
      muxers: []
    })

    const connections = await Promise.all([
      localUpgrader.upgradeOutbound(outbound),
      remoteUpgrader.upgradeInbound(inbound)
    ])

    expect(connections).to.have.length(2)

    await expect(connections[0].newStream('/echo/1.0.0')).to.be.rejected()

    // Verify the MultiaddrConnection close method is called
    const inboundCloseSpy = sinon.spy(inbound, 'close')
    const outboundCloseSpy = sinon.spy(outbound, 'close')
    await Promise.all(connections.map(async conn => await conn.close()))
    expect(inboundCloseSpy.callCount).to.equal(1)
    expect(outboundCloseSpy.callCount).to.equal(1)
  })

  it('should use a private connection protector when provided', async () => {
    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })

    const protector = new PreSharedKeyConnectionProtector({
      psk: uint8ArrayFromString(swarmKey)
    })
    const protectorProtectSpy = sinon.spy(protector, 'protect')

    localComponents.setConnectionProtector(protector)
    remoteComponents.setConnectionProtector(protector)

    const connections = await Promise.all([
      localUpgrader.upgradeOutbound(outbound),
      remoteUpgrader.upgradeInbound(inbound)
    ])

    expect(connections).to.have.length(2)

    const { stream, protocol } = await connections[0].newStream('/echo/1.0.0')
    expect(protocol).to.equal('/echo/1.0.0')

    const hello = uint8ArrayFromString('hello there!')
    const result = await pipe(
      [hello],
      stream,
      function toBuffer (source) {
        return (async function * () {
          for await (const val of source) yield val.slice()
        })()
      },
      async (source) => await all(source)
    )

    expect(result).to.eql([hello])
    expect(protectorProtectSpy.callCount).to.eql(2)
  })

  it('should fail if crypto fails', async () => {
    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })

    class BoomCrypto implements ConnectionEncrypter {
      static protocol = '/insecure'
      public protocol = '/insecure'
      async secureInbound (): Promise<SecuredConnection> { throw new Error('Boom') }
      async secureOutbound (): Promise<SecuredConnection> { throw new Error('Boom') }
    }

    localUpgrader = new DefaultUpgrader(localComponents, {
      connectionEncryption: [
        new BoomCrypto()
      ],
      muxers: []
    })
    remoteUpgrader = new DefaultUpgrader(remoteComponents, {
      connectionEncryption: [
        new BoomCrypto()
      ],
      muxers: []
    })

    // Wait for the results of each side of the connection
    const results = await pSettle([
      localUpgrader.upgradeOutbound(outbound),
      remoteUpgrader.upgradeInbound(inbound)
    ])

    // Ensure both sides fail
    expect(results).to.have.length(2)
    results.forEach(result => {
      expect(result).to.have.property('isRejected', true)
      expect(result).to.have.nested.property('reason.code', codes.ERR_ENCRYPTION_FAILED)
    })
  })

  it('should fail if muxers do not match', async () => {
    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })

    class OtherMuxer implements StreamMuxer {
      protocol = '/muxer-local'
      streams = []
      newStream (name?: string): Stream {
        throw new Error('Not implemented')
      }

      source = []
      async sink () {}
    }

    class OtherMuxerFactory implements StreamMuxerFactory {
      protocol = '/muxer-local'

      createStreamMuxer (components: Components, init?: StreamMuxerInit): StreamMuxer {
        return new OtherMuxer()
      }
    }

    localUpgrader = new DefaultUpgrader(localComponents, {
      connectionEncryption: [
        new Plaintext()
      ],
      muxers: [
        new OtherMuxerFactory()
      ]
    })
    remoteUpgrader = new DefaultUpgrader(remoteComponents, {
      connectionEncryption: [
        new Plaintext()
      ],
      muxers: [
        new Mplex()
      ]
    })

    // Wait for the results of each side of the connection
    const results = await pSettle([
      localUpgrader.upgradeOutbound(outbound),
      remoteUpgrader.upgradeInbound(inbound)
    ])

    // Ensure both sides fail
    expect(results).to.have.length(2)
    results.forEach(result => {
      expect(result).to.have.property('isRejected', true)
      expect(result).to.have.nested.property('reason.code', codes.ERR_MUXER_UNAVAILABLE)
    })
  })

  it('should map getStreams and close methods', async () => {
    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })

    const connections = await Promise.all([
      localUpgrader.upgradeOutbound(outbound),
      remoteUpgrader.upgradeInbound(inbound)
    ])

    expect(connections).to.have.length(2)

    // Create a few streams, at least 1 in each direction
    await connections[0].newStream('/echo/1.0.0')
    await connections[1].newStream('/echo/1.0.0')
    await connections[0].newStream('/echo/1.0.0')
    connections.forEach(conn => {
      expect(conn.streams).to.have.length(3)
    })

    // Verify the MultiaddrConnection close method is called
    const inboundCloseSpy = sinon.spy(inbound, 'close')
    const outboundCloseSpy = sinon.spy(outbound, 'close')
    await Promise.all(connections.map(async conn => await conn.close()))
    expect(inboundCloseSpy.callCount).to.equal(1)
    expect(outboundCloseSpy.callCount).to.equal(1)
  })

  it('should call connection handlers', async () => {
    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })
    const localConnectionEventReceived = pDefer()
    const localConnectionEndEventReceived = pDefer()
    const remoteConnectionEventReceived = pDefer()
    const remoteConnectionEndEventReceived = pDefer()

    localUpgrader.addEventListener('connection', () => {
      localConnectionEventReceived.resolve()
    })
    localUpgrader.addEventListener('connectionEnd', () => {
      localConnectionEndEventReceived.resolve()
    })
    remoteUpgrader.addEventListener('connection', () => {
      remoteConnectionEventReceived.resolve()
    })
    remoteUpgrader.addEventListener('connectionEnd', () => {
      remoteConnectionEndEventReceived.resolve()
    })

    // Verify onConnection is called with the connection
    const connections = await Promise.all([
      localUpgrader.upgradeOutbound(outbound),
      remoteUpgrader.upgradeInbound(inbound)
    ])
    expect(connections).to.have.length(2)

    await Promise.all([
      localConnectionEventReceived.promise,
      remoteConnectionEventReceived.promise
    ])

    // Verify onConnectionEnd is called with the connection
    await Promise.all(connections.map(async conn => await conn.close()))

    await Promise.all([
      localConnectionEndEventReceived.promise,
      remoteConnectionEndEventReceived.promise
    ])
  })

  it('should fail to create a stream for an unsupported protocol', async () => {
    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })

    const connections = await Promise.all([
      localUpgrader.upgradeOutbound(outbound),
      remoteUpgrader.upgradeInbound(inbound)
    ])

    expect(connections).to.have.length(2)

    const results = await pSettle([
      connections[0].newStream('/unsupported/1.0.0'),
      connections[1].newStream('/unsupported/1.0.0')
    ])
    expect(results).to.have.length(2)
    results.forEach(result => {
      expect(result).to.have.property('isRejected', true)
      expect(result).to.have.nested.property('reason.code', codes.ERR_UNSUPPORTED_PROTOCOL)
    })
  })
})

describe('libp2p.upgrader', () => {
  let peers: PeerId[]
  let libp2p: Libp2pNode
  let remoteLibp2p: Libp2pNode

  before(async () => {
    peers = await Promise.all([
      createFromJSON(Peers[0]),
      createFromJSON(Peers[1])
    ])
  })

  afterEach(async () => {
    sinon.restore()

    if (libp2p != null) {
      await libp2p.stop()
    }

    if (remoteLibp2p != null) {
      await remoteLibp2p.stop()
    }
  })

  it('should create an Upgrader', async () => {
    libp2p = await createLibp2pNode({
      peerId: peers[0],
      transports: [
        new WebSockets()
      ],
      streamMuxers: [
        new Mplex()
      ],
      connectionEncryption: [
        NOISE
      ],
      connectionProtector: new PreSharedKeyConnectionProtector({
        psk: uint8ArrayFromString(swarmKey)
      })
    })

    expect(libp2p.components.getUpgrader()).to.exist()
    expect(libp2p.components.getConnectionProtector()).to.exist()
  })

  it('should return muxed streams', async () => {
    const remotePeer = peers[1]
    libp2p = await createLibp2pNode({
      peerId: peers[0],
      transports: [
        new WebSockets()
      ],
      streamMuxers: [
        new Mplex()
      ],
      connectionEncryption: [
        NOISE
      ]
    })
    await libp2p.start()
    const echoHandler = () => {}
    await libp2p.handle(['/echo/1.0.0'], echoHandler)

    remoteLibp2p = await createLibp2pNode({
      peerId: remotePeer,
      transports: [
        new WebSockets()
      ],
      streamMuxers: [
        new Mplex()
      ],
      connectionEncryption: [
        NOISE
      ]
    })
    await remoteLibp2p.start()
    await remoteLibp2p.handle('/echo/1.0.0', echoHandler)

    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })
    const [localConnection] = await Promise.all([
      libp2p.components.getUpgrader().upgradeOutbound(outbound),
      remoteLibp2p.components.getUpgrader().upgradeInbound(inbound)
    ])
    const remoteLibp2pUpgraderOnStreamSpy = sinon.spy(remoteLibp2p.components.getUpgrader() as DefaultUpgrader, '_onStream')

    const { stream } = await localConnection.newStream(['/echo/1.0.0'])
    expect(stream).to.include.keys(['id', 'close', 'reset', 'timeline'])

    const [arg0] = remoteLibp2pUpgraderOnStreamSpy.getCall(0).args
    expect(arg0.stream).to.include.keys(['id', 'close', 'reset', 'timeline'])
  })

  it('should emit connect and disconnect events', async () => {
    const remotePeer = peers[1]
    libp2p = await createLibp2pNode({
      peerId: peers[0],
      transports: [
        new WebSockets()
      ],
      streamMuxers: [
        new Mplex()
      ],
      connectionEncryption: [
        NOISE
      ]
    })
    await libp2p.start()

    remoteLibp2p = await createLibp2pNode({
      peerId: remotePeer,
      transports: [
        new WebSockets()
      ],
      streamMuxers: [
        new Mplex()
      ],
      connectionEncryption: [
        NOISE
      ]
    })
    await remoteLibp2p.start()

    const { inbound, outbound } = mockMultiaddrConnPair({ addrs, remotePeer })

    // Spy on emit for easy verification
    const connectionManagerDispatchEventSpy = sinon.spy(libp2p.components.getConnectionManager(), 'dispatchEvent')

    // Upgrade and check the connect event
    const connections = await Promise.all([
      libp2p.components.getUpgrader().upgradeOutbound(outbound),
      remoteLibp2p.components.getUpgrader().upgradeInbound(inbound)
    ])
    expect(connectionManagerDispatchEventSpy.callCount).to.equal(1)

    let [event] = connectionManagerDispatchEventSpy.getCall(0).args
    expect(event).to.have.property('type', 'peer:connect')
    // @ts-expect-error detail is only on CustomEvent type
    expect(remotePeer.equals(event.detail.remotePeer)).to.equal(true)

    // Close and check the disconnect event
    await Promise.all(connections.map(async conn => await conn.close()))
    expect(connectionManagerDispatchEventSpy.callCount).to.equal(2)
    ;([event] = connectionManagerDispatchEventSpy.getCall(1).args)
    expect(event).to.have.property('type', 'peer:disconnect')
    // @ts-expect-error detail is only on CustomEvent type
    expect(remotePeer.equals(event.detail.remotePeer)).to.equal(true)
  })
})
