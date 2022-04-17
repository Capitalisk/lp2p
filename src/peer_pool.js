/*
 * Copyright © 2019 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 *
 */

/**
 * The purpose of the PeerPool is to provide a simple interface for selecting,
 * interacting with and handling aggregated events from a collection of peers.
 */

const { EventEmitter } = require('events');
const shuffle = require('lodash.shuffle');
const { SCServerSocket } = require('socketcluster-server');
const { RequestFailError, SendFailError } = require('./errors');
const { P2PRequest } = require('./p2p_request');
const {
  ConnectionState,
  EVENT_BAN_PEER,
  EVENT_CLOSE_INBOUND,
  EVENT_CLOSE_OUTBOUND,
  EVENT_CONNECT_ABORT_OUTBOUND,
  EVENT_CONNECT_OUTBOUND,
  EVENT_DISCOVERED_PEER,
  EVENT_FAILED_PEER_INFO_UPDATE,
  EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT,
  EVENT_FAILED_TO_FETCH_PEER_INFO,
  EVENT_FAILED_TO_FETCH_PEERS,
  EVENT_FAILED_TO_PUSH_NODE_INFO,
  EVENT_INBOUND_SOCKET_ERROR,
  EVENT_MESSAGE_RECEIVED,
  EVENT_OUTBOUND_SOCKET_ERROR,
  EVENT_REQUEST_RECEIVED,
  EVENT_UNBAN_PEER,
  EVENT_UPDATED_PEER_INFO,
  PEER_KIND_OUTBOUND,
  PEER_KIND_INBOUND,
  InboundPeer,
  OutboundPeer,
  Peer,
  PeerConfig,
} = require('./peer');
const { getUniquePeersbyIp } = require('./peer_selection');
const { constructPeerIdFromPeerInfo } = require('./utils');

const { EVICTED_PEER_CODE } = require('./disconnect_status_codes');

const MAX_PEER_LIST_BATCH_SIZE = 100;
const MAX_PEER_DISCOVERY_PROBE_SAMPLE_SIZE = 100;
const EVENT_REMOVE_PEER = 'removePeer';
const INTENTIONAL_DISCONNECT_STATUS_CODE = 1000;

// TODO: Move to events.ts.
const EVENT_FAILED_TO_SEND_MESSAGE = 'failedToSendMessage';

const PROTECTION_CATEGORY = {
  LATENCY: 'latency',
  RESPONSE_RATE: 'responseRate',
  CONNECT_TIME: 'connectTime'
};

const filterPeersByCategory = (peers, options) => {
  // tslint:disable-next-line no-magic-numbers
  if (options.percentage > 1 || options.percentage < 0) {
    return peers;
  }
  const peerCount = Math.ceil(peers.length * options.percentage);
  const sign = !!options.asc ? 1 : -1;

  return peers
    .sort((a, b) =>
      a[options.category] > b[options.category] ? sign : sign * -1,
    )
    .slice(peerCount, peers.length);
};

class PeerPool extends EventEmitter {
  constructor(peerPoolConfig) {
    super();
    this._inboundPeerMap = new Map();
    this._outboundPeerMap = new Map();
    this._peerPoolConfig = peerPoolConfig;
    this._peerConfig = {
      connectTimeout: this._peerPoolConfig.connectTimeout,
      ackTimeout: this._peerPoolConfig.ackTimeout,
      wsMaxMessageRate: this._peerPoolConfig.wsMaxMessageRate,
      wsMaxMessageRatePenalty: this._peerPoolConfig.wsMaxMessageRatePenalty,
      maxPeerDiscoveryResponseLength: this._peerPoolConfig
        .maxPeerDiscoveryResponseLength,
      rateCalculationInterval: this._peerPoolConfig.rateCalculationInterval,
      wsMaxPayloadInbound: this._peerPoolConfig.wsMaxPayloadInbound,
      wsMaxPayloadOutbound: this._peerPoolConfig.wsMaxPayloadOutbound,
      maxPeerInfoSize: this._peerPoolConfig.maxPeerInfoSize,
      secret: this._peerPoolConfig.secret,
    };
    this._peerLists = peerPoolConfig.peerLists;
    this._peerSelectForSend = peerPoolConfig.peerSelectionForSend;
    this._peerSelectForRequest = peerPoolConfig.peerSelectionForRequest;
    this._peerSelectForConnection = peerPoolConfig.peerSelectionForConnection;
    this._maxOutboundConnections = peerPoolConfig.maxOutboundConnections;
    this._maxInboundConnections = peerPoolConfig.maxInboundConnections;
    this._sendPeerLimit = peerPoolConfig.sendPeerLimit;
    this._outboundShuffleIntervalId = setInterval(() => {
      this._evictPeer(PEER_KIND_OUTBOUND);
    }, peerPoolConfig.outboundShuffleInterval);

    // This needs to be an arrow function so that it can be used as a listener.
    this._handlePeerRPC = (request) => {
      // Re-emit the request to allow it to bubble up the class hierarchy.
      this.emit(EVENT_REQUEST_RECEIVED, request);
    };

    // This needs to be an arrow function so that it can be used as a listener.
    this._handlePeerMessage = (message) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_MESSAGE_RECEIVED, message);
    };

    // This needs to be an arrow function so that it can be used as a listener.
    this._handleDiscoverPeer = (peerInfo) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_DISCOVERED_PEER, peerInfo);
    };

    this._handleOutboundPeerConnect = async (peerInfo) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_CONNECT_OUTBOUND, peerInfo);
    };
    this._handleOutboundPeerConnectAbort = (peerInfo) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_CONNECT_ABORT_OUTBOUND, peerInfo);
    };
    this._handlePeerCloseOutbound = (closePacket) => {
      const peerId = constructPeerIdFromPeerInfo(closePacket.peerInfo);
      this.removeOutboundPeer(
        peerId,
        closePacket.code,
        `Outbound peer ${peerId} disconnected with reason: ${
          closePacket.reason || 'Unknown reason'
        }`,
      );
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_CLOSE_OUTBOUND, closePacket);
    };
    this._handlePeerCloseInbound = (closePacket) => {
      const peerId = constructPeerIdFromPeerInfo(closePacket.peerInfo);
      this.removeInboundPeer(
        peerId,
        closePacket.code,
        `Inbound peer ${peerId} disconnected with reason: ${
          closePacket.reason || 'Unknown reason'
        }`,
      );
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_CLOSE_INBOUND, closePacket);
    };
    this._handlePeerOutboundSocketError = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_OUTBOUND_SOCKET_ERROR, error);
    };
    this._handlePeerInboundSocketError = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_INBOUND_SOCKET_ERROR, error);
    };
    this._handlePeerInfoUpdate = (peerInfo) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_UPDATED_PEER_INFO, peerInfo);
    };
    this._handleFailedPeerInfoUpdate = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_PEER_INFO_UPDATE, error);
    };
    this._handleFailedToFetchPeerInfo = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_TO_FETCH_PEER_INFO, error);
    };
    this._handleFailedToFetchPeers = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_TO_FETCH_PEERS, error);
    };
    this._handleFailedToCollectPeerDetails = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT, error);
    };
    this._handleBanPeer = (peerId) => {
      // Unban peer after peerBanTime
      setTimeout(
        this._handleUnbanPeer.bind(this, peerId),
        this._peerPoolConfig.peerBanTime,
      );
      // Re-emit the peerId to allow it to bubble up the class hierarchy.
      this.emit(EVENT_BAN_PEER, peerId);
    };
    this._handleUnbanPeer = (peerId) => {
      // Re-emit the peerId to allow it to bubble up the class hierarchy.
      this.emit(EVENT_UNBAN_PEER, peerId);
    };
  }

  applyNodeInfo(nodeInfo) {
    this._nodeInfo = nodeInfo;
    const peerList = this.getPeers();
    peerList.forEach(peer => {
      this._applyNodeInfoOnPeer(peer, nodeInfo);
    });
  }

  get nodeInfo() {
    return this._nodeInfo;
  }

  get peerConfig() {
    return { ...this._peerConfig };
  }

  async request(packet) {
    const listOfPeerInfo = [
      ...this._outboundPeerMap.values(),
      ...this._inboundPeerMap.values(),
    ].map((peer) => ({
      ...(peer.peerInfo),
      kind: peer.kind,
    }));

    // This function can be customized so we should pass as much info as possible.
    const selectedPeers = this._peerSelectForRequest({
      peers: listOfPeerInfo,
      nodeInfo: this._nodeInfo,
      peerLimit: 1,
      requestPacket: packet,
    });

    if (selectedPeers.length <= 0) {
      throw new RequestFailError(
        'Request failed due to no peers found in peer selection',
      );
    }

    const selectedPeerId = constructPeerIdFromPeerInfo(selectedPeers[0]);

    return this.requestFromPeer(packet, selectedPeerId);
  }

  send(packet, peerLimit) {
    const listOfPeerInfo = [
      ...this._outboundPeerMap.values(),
      ...this._inboundPeerMap.values(),
    ].map((peer) => ({
      ...(peer.peerInfo),
      kind: peer.kind,
    }));
    if (peerLimit == null) {
      peerLimit = this._sendPeerLimit;
    } else if (peerLimit === -1) {
      peerLimit = listOfPeerInfo.length;
    }
    // This function can be customized so we should pass as much info as possible.
    const selectedPeers = this._peerSelectForSend({
      peers: listOfPeerInfo,
      nodeInfo: this._nodeInfo,
      peerLimit,
      messagePacket: packet,
    });

    selectedPeers.forEach((peerInfo) => {
      const selectedPeerId = constructPeerIdFromPeerInfo(peerInfo);
      try {
        this.sendToPeer(packet, selectedPeerId);
      } catch (error) {
        this.emit(EVENT_FAILED_TO_SEND_MESSAGE, error);
      }
    });
  }

  async requestFromPeer(packet, peerId) {
    const peer = this._outboundPeerMap.get(peerId) ||
      this._inboundPeerMap.get(peerId);

    if (!peer) {
      throw new RequestFailError(
        `Request failed because a peer with id ${peerId} could not be found`,
      );
    }

    return peer.request(packet);
  }

  sendToPeer(message, peerId) {
    const peer = this._outboundPeerMap.get(peerId) ||
      this._inboundPeerMap.get(peerId);

    if (!peer) {
      throw new SendFailError(
        `Send failed because a peer with id ${peerId} could not be found`,
      );
    }
    peer.send(message);
  }

  triggerNewConnections(newPeers, triedPeers, fixedPeers) {
    // Try to connect to disconnected peers without including the fixed ones which are specially treated thereafter
    const disconnectedNewPeers = newPeers.filter(
      newPeer =>
        !this._outboundPeerMap.has(constructPeerIdFromPeerInfo(newPeer)) &&
        !fixedPeers
          .map(fixedPeer => fixedPeer.ipAddress)
          .includes(newPeer.ipAddress),
    );
    const disconnectedTriedPeers = triedPeers.filter(
      triedPeer =>
        !this._outboundPeerMap.has(constructPeerIdFromPeerInfo(triedPeer)) &&
        !fixedPeers
          .map(fixedPeer => fixedPeer.ipAddress)
          .includes(triedPeer.ipAddress),
    );

    const mapToConnectedPeerInfo = (peerInfo) => {
      return {
        kind: this._outboundPeerMap.get(constructPeerIdFromPeerInfo(peerInfo)).kind,
        ...peerInfo
      };
    };

    const connectedNewPeers = newPeers
      .filter(newPeer => this._outboundPeerMap.has(constructPeerIdFromPeerInfo(newPeer)))
      .map(mapToConnectedPeerInfo);

    const connectedTriedPeers = triedPeers
      .filter(triedPeer => this._outboundPeerMap.has(constructPeerIdFromPeerInfo(triedPeer)))
      .map(mapToConnectedPeerInfo);

    const { outboundCount, inboundCount } = this.getPeersCountPerKind();
    const disconnectedFixedPeers = fixedPeers
      .filter(peer => !this._outboundPeerMap.get(constructPeerIdFromPeerInfo(peer)));

    // This function can be customized so we should pass as much info as possible.
    const peersToConnect = this._peerSelectForConnection({
      nodeInfo: this._nodeInfo,
      disconnectedNewPeers,
      disconnectedTriedPeers,
      connectedNewPeers,
      connectedTriedPeers,
      outboundPeerCount: outboundCount,
      inboundPeerCount: inboundCount,
      maxOutboundPeerCount: this._maxOutboundConnections,
      maxInboundPeerCount: this._maxInboundConnections
    });

    [...peersToConnect, ...disconnectedFixedPeers].forEach(
      (peerInfo) => {
        const peerId = constructPeerIdFromPeerInfo(peerInfo);
        return this.addOutboundPeer(peerId, peerInfo);
      },
    );
  }

  addInboundPeer(peerInfo, socket) {
    let moduleCount;
    if (this._nodeInfo && this._nodeInfo.modules) {
      moduleCount = Object.keys(this._nodeInfo.modules).length + 1;
    } else {
      moduleCount = 1;
    }
    const inboundPeers = this.getPeers(PEER_KIND_INBOUND);

    if (inboundPeers.length >= this._maxInboundConnections * moduleCount) {
      this._evictPeer(PEER_KIND_INBOUND);
    }

    const peer = new InboundPeer(peerInfo, socket, {
      ...this._peerConfig,
    });

    // Throw an error because adding a peer multiple times is a common developer error which is very difficult to identify and debug.
    if (this._inboundPeerMap.has(peer.id)) {
      throw new Error(`Peer ${peer.id} was already in the peer pool`);
    }
    this._inboundPeerMap.set(peer.id, peer);
    this._bindHandlersToPeer(peer);
    if (this._nodeInfo) {
      this._applyNodeInfoOnPeer(peer, this._nodeInfo);
    }
    peer.connect();

    return peer;
  }

  addOutboundPeer(peerId, peerInfo) {
    const existingPeer = this._outboundPeerMap.get(peerId);
    if (existingPeer) {
      return existingPeer;
    }

    const peer = new OutboundPeer(peerInfo, { ...this._peerConfig });

    this._outboundPeerMap.set(peer.id, peer);
    this._bindHandlersToPeer(peer);
    if (this._nodeInfo) {
      this._applyNodeInfoOnPeer(peer, this._nodeInfo);
    }

    return peer;
  }

  getPeersCountPerKind() {
    return {
      outboundCount: this._outboundPeerMap.size,
      inboundCount: this._inboundPeerMap.size,
    };
  }

  removeAllPeers() {
    // Clear periodic eviction of outbound peers for shuffling
    if (this._outboundShuffleIntervalId) {
      clearInterval(this._outboundShuffleIntervalId);
    }

    this._outboundPeerMap.forEach((peer) => {
      this.removeOutboundPeer(
        peer.id,
        INTENTIONAL_DISCONNECT_STATUS_CODE,
        `Intentionally removed outbound peer ${peer.id}`,
      );
    });

    this._inboundPeerMap.forEach((peer) => {
      this.removeInboundPeer(
        peer.id,
        INTENTIONAL_DISCONNECT_STATUS_CODE,
        `Intentionally removed inbound peer ${peer.id}`,
      );
    });
  }

  getPeers(kind) {
    if (kind === PEER_KIND_OUTBOUND) {
      return [...this._outboundPeerMap.values()];
    } else if (kind === PEER_KIND_INBOUND) {
      return [...this._inboundPeerMap.values()];
    }
    return [...this._outboundPeerMap.values(), ...this._inboundPeerMap.values()];
  }

  getUniqueOutboundConnectedPeers() {
    return getUniquePeersbyIp(this.getAllConnectedPeerInfos(PEER_KIND_OUTBOUND));
  }

  getAllConnectedPeerInfos(kind) {
    return this.getConnectedPeers(kind).map(peer => peer.peerInfo);
  }

  getConnectedPeers(kind) {
    if (kind === PEER_KIND_OUTBOUND) {
      return [...this._outboundPeerMap.values()].filter(
        peer => peer.state === ConnectionState.OPEN,
      );
    } else if (kind === PEER_KIND_INBOUND) {
      return [...this._inboundPeerMap.values()].filter(
        peer => peer.state === ConnectionState.OPEN,
      );
    }

    return [
      ...this._outboundPeerMap.values(),
      ...this._inboundPeerMap.values(),
    ].filter(peer => peer.state === ConnectionState.OPEN);
  }

  getPeer(peerId) {
    return this._outboundPeerMap.get(peerId) || this._inboundPeerMap.get(peerId);
  }

  getOutboundPeer(peerId) {
    return this._outboundPeerMap.get(peerId);
  }

  getInboundPeer(peerId) {
    return this._inboundPeerMap.get(peerId);
  }

  hasPeer(peerId) {
    return this._outboundPeerMap.has(peerId) || this._inboundPeerMap.has(peerId);
  }

  hasOutboundPeer(peerId) {
    return this._outboundPeerMap.has(peerId);
  }

  hasInboundPeer(peerId) {
    return this._inboundPeerMap.has(peerId);
  }

  removeOutboundPeer(peerId, code, reason) {
    const peer = this._outboundPeerMap.get(peerId);
    if (peer) {
      peer.disconnect(code, reason);
      this._unbindHandlersFromPeer(peer);
    }
    let wasRemoved = this._outboundPeerMap.delete(peerId);
    this.emit(EVENT_REMOVE_PEER, peerId);

    return wasRemoved;
  }

  removeInboundPeer(peerId, code, reason) {
    const peer = this._inboundPeerMap.get(peerId);
    if (peer) {
      peer.disconnect(code, reason);
      this._unbindHandlersFromPeer(peer);
    }
    let wasRemoved = this._inboundPeerMap.delete(peerId);
    this.emit(EVENT_REMOVE_PEER, peerId);

    return wasRemoved;
  }

  applyPenalty(peerPenalty) {
    const outboundPeer = this._outboundPeerMap.get(peerPenalty.peerId);
    const inboundPeer = this._inboundPeerMap.get(peerPenalty.peerId);

    if (outboundPeer || inboundPeer) {
      if (outboundPeer) {
        outboundPeer.applyPenalty(peerPenalty.penalty);
      }
      if (inboundPeer) {
        inboundPeer.applyPenalty(peerPenalty.penalty);
      }

      return;
    }

    throw new Error('Peer not found');
  }

  _applyNodeInfoOnPeer(peer, nodeInfo) {
    // tslint:disable-next-line no-floating-promises
    (async () => {
      try {
        await peer.applyNodeInfo(nodeInfo);
      } catch (error) {
        this.emit(EVENT_FAILED_TO_PUSH_NODE_INFO, error);
      }
    })();
  }

  _selectPeersForEviction() {
    const peers = [...this.getPeers(PEER_KIND_INBOUND)].filter(peer =>
      this._peerLists.whitelisted.every(
        p => constructPeerIdFromPeerInfo(p) !== peer.id,
      ),
    );

    // Cannot manipulate without physically moving nodes closer to the target.
    const filteredPeersByLatency = this._peerPoolConfig.latencyProtectionRatio
      ? filterPeersByCategory(peers, {
          category: PROTECTION_CATEGORY.LATENCY,
          percentage: this._peerPoolConfig.latencyProtectionRatio,
          asc: true,
        })
      : peers;
    if (filteredPeersByLatency.length <= 1) {
      return filteredPeersByLatency;
    }

    // Cannot manipulate this metric without performing useful work.
    const filteredPeersByResponseRate = this._peerPoolConfig
      .productivityProtectionRatio
      ? filterPeersByCategory(filteredPeersByLatency, {
          category: PROTECTION_CATEGORY.RESPONSE_RATE,
          percentage: this._peerPoolConfig.productivityProtectionRatio,
          asc: false,
        })
      : filteredPeersByLatency;
    if (filteredPeersByResponseRate.length <= 1) {
      return filteredPeersByResponseRate;
    }

    // Protect remaining half of peers by longevity, precludes attacks that start later.
    const filteredPeersByConnectTime = this._peerPoolConfig
      .longevityProtectionRatio
      ? filterPeersByCategory(filteredPeersByResponseRate, {
          category: PROTECTION_CATEGORY.CONNECT_TIME,
          percentage: this._peerPoolConfig.longevityProtectionRatio,
          asc: true,
        })
      : filteredPeersByResponseRate;

    return filteredPeersByConnectTime;
  }

  _evictPeer(kind) {
    const peers = this.getPeers(kind);
    if (peers.length < 1) {
      return;
    }

    if (kind === PEER_KIND_OUTBOUND) {
      const selectedPeer = shuffle(
        peers.filter(peer =>
          this._peerLists.fixedPeers.every(
            p => constructPeerIdFromPeerInfo(p) !== peer.id,
          ),
        ),
      )[0];
      if (selectedPeer) {
        this.removeOutboundPeer(
          selectedPeer.id,
          EVICTED_PEER_CODE,
          `Evicted outbound peer ${selectedPeer.id}`,
        );
      }
    } else if (kind === PEER_KIND_INBOUND) {
      const evictionCandidates = this._selectPeersForEviction();
      const peerToEvict = shuffle(evictionCandidates)[0];
      if (peerToEvict) {
        this.removeInboundPeer(
          peerToEvict.id,
          EVICTED_PEER_CODE,
          `Evicted inbound peer ${peerToEvict.id}`,
        );
      }
    }
  }

  _bindHandlersToPeer(peer) {
    peer.on(EVENT_REQUEST_RECEIVED, this._handlePeerRPC);
    peer.on(EVENT_MESSAGE_RECEIVED, this._handlePeerMessage);
    peer.on(EVENT_CONNECT_OUTBOUND, this._handleOutboundPeerConnect);
    peer.on(EVENT_CONNECT_ABORT_OUTBOUND, this._handleOutboundPeerConnectAbort);
    peer.on(EVENT_CLOSE_OUTBOUND, this._handlePeerCloseOutbound);
    peer.on(EVENT_CLOSE_INBOUND, this._handlePeerCloseInbound);
    peer.on(EVENT_OUTBOUND_SOCKET_ERROR, this._handlePeerOutboundSocketError);
    peer.on(EVENT_INBOUND_SOCKET_ERROR, this._handlePeerInboundSocketError);
    peer.on(EVENT_UPDATED_PEER_INFO, this._handlePeerInfoUpdate);
    peer.on(EVENT_FAILED_PEER_INFO_UPDATE, this._handleFailedPeerInfoUpdate);
    peer.on(EVENT_FAILED_TO_FETCH_PEER_INFO, this._handleFailedToFetchPeerInfo);
    peer.on(EVENT_FAILED_TO_FETCH_PEERS, this._handleFailedToFetchPeers);
    peer.on(
      EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT,
      this._handleFailedToCollectPeerDetails,
    );
    peer.on(EVENT_BAN_PEER, this._handleBanPeer);
    peer.on(EVENT_UNBAN_PEER, this._handleUnbanPeer);
    peer.on(EVENT_DISCOVERED_PEER, this._handleDiscoverPeer);
  }

  _unbindHandlersFromPeer(peer) {
    peer.removeListener(EVENT_REQUEST_RECEIVED, this._handlePeerRPC);
    peer.removeListener(EVENT_MESSAGE_RECEIVED, this._handlePeerMessage);
    peer.removeListener(
      EVENT_CONNECT_OUTBOUND,
      this._handleOutboundPeerConnect,
    );
    peer.removeListener(
      EVENT_CONNECT_ABORT_OUTBOUND,
      this._handleOutboundPeerConnectAbort,
    );
    peer.removeListener(EVENT_CLOSE_OUTBOUND, this._handlePeerCloseOutbound);
    peer.removeListener(EVENT_CLOSE_INBOUND, this._handlePeerCloseInbound);
    peer.removeListener(EVENT_UPDATED_PEER_INFO, this._handlePeerInfoUpdate);
    peer.removeListener(
      EVENT_FAILED_TO_FETCH_PEER_INFO,
      this._handleFailedToFetchPeerInfo,
    );
    peer.removeListener(
      EVENT_FAILED_TO_FETCH_PEERS,
      this._handleFailedToFetchPeers,
    );
    peer.removeListener(
      EVENT_FAILED_PEER_INFO_UPDATE,
      this._handleFailedPeerInfoUpdate,
    );
    peer.removeListener(
      EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT,
      this._handleFailedToCollectPeerDetails,
    );
    peer.removeListener(EVENT_BAN_PEER, this._handleBanPeer);
    peer.removeListener(EVENT_UNBAN_PEER, this._handleUnbanPeer);
    peer.removeListener(EVENT_DISCOVERED_PEER, this._handleDiscoverPeer);
  }
}

module.exports = {
  EVENT_CLOSE_INBOUND,
  EVENT_CLOSE_OUTBOUND,
  EVENT_CONNECT_OUTBOUND,
  EVENT_CONNECT_ABORT_OUTBOUND,
  EVENT_REQUEST_RECEIVED,
  EVENT_MESSAGE_RECEIVED,
  EVENT_OUTBOUND_SOCKET_ERROR,
  EVENT_INBOUND_SOCKET_ERROR,
  EVENT_UPDATED_PEER_INFO,
  EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT,
  EVENT_FAILED_TO_FETCH_PEER_INFO,
  EVENT_FAILED_TO_FETCH_PEERS,
  EVENT_BAN_PEER,
  EVENT_UNBAN_PEER,
  EVENT_FAILED_PEER_INFO_UPDATE,
  EVENT_FAILED_TO_PUSH_NODE_INFO,
  EVENT_DISCOVERED_PEER,
  MAX_PEER_LIST_BATCH_SIZE,
  MAX_PEER_DISCOVERY_PROBE_SAMPLE_SIZE,
  EVENT_REMOVE_PEER,
  INTENTIONAL_DISCONNECT_STATUS_CODE,
  EVENT_FAILED_TO_SEND_MESSAGE,
  PEER_KIND_OUTBOUND,
  PEER_KIND_INBOUND,
  PROTECTION_CATEGORY,
  PeerPool
};
