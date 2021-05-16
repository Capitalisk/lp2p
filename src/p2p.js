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

const crypto = require('crypto');
const { EventEmitter } = require('events');
const http = require('http');

const shuffle = require('lodash.shuffle');
const { attach, SCServer, SCServerSocket } = require('socketcluster-server');
const url = require('url');

const { REMOTE_RPC_GET_PEERS_LIST } = require('./peer');

const { PeerBook } = require('./peer_book');

const {
  DUPLICATE_CONNECTION,
  DUPLICATE_CONNECTION_REASON,
  FORBIDDEN_CONNECTION,
  FORBIDDEN_CONNECTION_REASON,
  INCOMPATIBLE_PEER_CODE,
  INCOMPATIBLE_PEER_UNKNOWN_REASON,
  INVALID_CONNECTION_QUERY_CODE,
  INVALID_CONNECTION_QUERY_REASON,
  INVALID_CONNECTION_SELF_CODE,
  INVALID_CONNECTION_SELF_REASON,
  INVALID_CONNECTION_URL_CODE,
  INVALID_CONNECTION_URL_REASON,
} = require('./disconnect_status_codes');

const { PeerInboundHandshakeError } = require('./errors');

const { P2PRequest } = require('./p2p_request');
const {
  selectPeersForConnection,
  selectPeersForRequest,
  selectPeersForSend,
} = require('./peer_selection');

const {
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
  EVENT_FAILED_TO_SEND_MESSAGE,
  EVENT_INBOUND_SOCKET_ERROR,
  EVENT_MESSAGE_RECEIVED,
  EVENT_OUTBOUND_SOCKET_ERROR,
  EVENT_REMOVE_PEER,
  EVENT_REQUEST_RECEIVED,
  EVENT_UNBAN_PEER,
  EVENT_UPDATED_PEER_INFO,
  PeerPool,
} = require('./peer_pool');
const { constructPeerIdFromPeerInfo } = require('./utils');
const {
  checkPeerCompatibility,
  outgoingPeerInfoSanitization,
  sanitizePeerLists,
} = require('./validation');

const EVENT_NEW_INBOUND_PEER = 'newInboundPeer';
const EVENT_FAILED_TO_ADD_INBOUND_PEER = 'failedToAddInboundPeer';
const EVENT_NEW_PEER = 'newPeer';
const EVENT_NETWORK_READY = 'networkReady';

const DEFAULT_NODE_HOST_IP = '0.0.0.0';
const DEFAULT_DISCOVERY_INTERVAL = 30000;
const DEFAULT_BAN_TIME = 86400;
const DEFAULT_POPULATOR_INTERVAL = 10000;
const DEFAULT_SEND_PEER_LIMIT = 24;
// Max rate of WebSocket messages per second per peer.
const DEFAULT_WS_MAX_MESSAGE_RATE = 100;
const DEFAULT_WS_MAX_MESSAGE_RATE_PENALTY = 100;
const DEFAULT_RATE_CALCULATION_INTERVAL = 1000;
const DEFAULT_WS_MAX_PAYLOAD_OUTBOUND = 3000000; // Size in bytes
const DEFAULT_WS_MAX_PAYLOAD_INBOUND = 40000; // Size in bytes

const BASE_10_RADIX = 10;
const DEFAULT_MAX_OUTBOUND_CONNECTIONS = 20;
const DEFAULT_MAX_INBOUND_CONNECTIONS = 100;
const DEFAULT_OUTBOUND_SHUFFLE_INTERVAL = 300000;
const DEFAULT_PEER_PROTECTION_FOR_NETGROUP = 0.034;
const DEFAULT_PEER_PROTECTION_FOR_LATENCY = 0.068;
const DEFAULT_PEER_PROTECTION_FOR_USEFULNESS = 0.068;
const DEFAULT_PEER_PROTECTION_FOR_LONGEVITY = 0.5;
const DEFAULT_MIN_PEER_DISCOVERY_THRESHOLD = 100;
const DEFAULT_MAX_PEER_DISCOVERY_RESPONSE_LENGTH = 100;
const DEFAULT_MAX_PEER_INFO_SIZE = 20000; // Size in bytes

const SECRET_BYTE_LENGTH = 4;
const DEFAULT_RANDOM_SECRET = crypto.randomBytes(SECRET_BYTE_LENGTH).readUInt32BE(0);

const selectRandomPeerSample = (peerList, count) => shuffle(peerList).slice(0, count);

class P2P extends EventEmitter {
  constructor(config) {
    super();
    this._sanitizedPeerLists = sanitizePeerLists(
      {
        seedPeers: config.seedPeers || [],
        blacklistedPeers: config.blacklistedPeers || [],
        fixedPeers: config.fixedPeers || [],
        whitelisted: config.whitelistedPeers || [],
        previousPeers: config.previousPeers || [],
      },
      {
        ipAddress: config.hostIp || DEFAULT_NODE_HOST_IP,
        wsPort: config.nodeInfo.wsPort,
      },
    );
    this._config = config;
    this._isActive = false;
    this._hasConnected = false;
    this._peerBook = new PeerBook({
      secret: config.secret ? config.secret : DEFAULT_RANDOM_SECRET,
    });
    this._bannedPeers = new Set();
    this._httpServer = http.createServer();
    this._scServer = attach(this._httpServer, {
      wsEngineServerOptions: {
        maxPayload: config.wsMaxPayloadInbound
          ? config.wsMaxPayloadInbound
          : DEFAULT_WS_MAX_PAYLOAD_INBOUND,
      },
    });

    // This needs to be an arrow function so that it can be used as a listener.
    this._handlePeerPoolRPC = (request) => {
      if (request.procedure === REMOTE_RPC_GET_PEERS_LIST) {
        this._handleGetPeersRequest(request);
      }
      // Re-emit the request for external use.
      this.emit(EVENT_REQUEST_RECEIVED, request);
    };

    // This needs to be an arrow function so that it can be used as a listener.
    this._handlePeerPoolMessage = (message) => {
      // Re-emit the message for external use.
      this.emit(EVENT_MESSAGE_RECEIVED, message);
    };

    this._handleOutboundPeerConnect = (peerInfo) => {
      const foundTriedPeer = this._peerBook.getPeer(peerInfo);

      if (foundTriedPeer) {
        const updatedPeerInfo = {
          ...peerInfo,
          ipAddress: foundTriedPeer.ipAddress,
          wsPort: foundTriedPeer.wsPort,
        };
        this._peerBook.upgradePeer(updatedPeerInfo);
      } else if (!peerInfo.isPassive) {
        this._peerBook.addPeer(peerInfo);
        // Should be added to newPeer list first and since it is connected so we will upgrade it
        this._peerBook.upgradePeer(peerInfo);
      }

      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_CONNECT_OUTBOUND, peerInfo);
      if (this._isNetworkReady()) {
        this.emit(EVENT_NETWORK_READY);
      }
    };

    this._handleOutboundPeerConnectAbort = (peerInfo) => {
      const peerId = constructPeerIdFromPeerInfo(peerInfo);
      const isWhitelisted = this._sanitizedPeerLists.whitelisted.find(
        peer => constructPeerIdFromPeerInfo(peer) === peerId,
      );
      if (this._peerBook.getPeer(peerInfo) && !isWhitelisted) {
        this._peerBook.downgradePeer(peerInfo);
      }

      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_CONNECT_ABORT_OUTBOUND, peerInfo);
    };

    this._handlePeerCloseOutbound = (closePacket) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_CLOSE_OUTBOUND, closePacket);
    };

    this._handlePeerCloseInbound = (closePacket) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_CLOSE_INBOUND, closePacket);
    };

    this._handleRemovePeer = (peerId) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_REMOVE_PEER, peerId);
    };

    this._handlePeerInfoUpdate = (peerInfo) => {
      const foundPeer = this._peerBook.getPeer(peerInfo);

      if (foundPeer) {
        const updatedPeerInfo = {
          ...peerInfo,
          ipAddress: foundPeer.ipAddress,
          wsPort: foundPeer.wsPort,
        };
        const isUpdated = this._peerBook.updatePeer(updatedPeerInfo);
        if (isUpdated) {
          // If found and updated successfully then upgrade the peer
          this._peerBook.upgradePeer(updatedPeerInfo);
        }
      } else if (!peerInfo.isPassive) {
        this._peerBook.addPeer(peerInfo);
        // Since the connection is tried already hence upgrade the peer
        this._peerBook.upgradePeer(peerInfo);
      }
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_UPDATED_PEER_INFO, peerInfo);
    };

    this._handleFailedPeerInfoUpdate = (error) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_PEER_INFO_UPDATE, error);
    };

    this._handleFailedToFetchPeerInfo = (error) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_TO_FETCH_PEER_INFO, error);
    };

    this._handleFailedToFetchPeers = (error) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_TO_FETCH_PEERS, error);
    };

    this._handleFailedToCollectPeerDetails = (error) => {
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT, error);
    };

    this._handleBanPeer = (peerId) => {
      this._bannedPeers.add(peerId.split(':')[0]);
      const isWhitelisted = this._sanitizedPeerLists.whitelisted.find(
        peer => constructPeerIdFromPeerInfo(peer) === peerId,
      );

      const bannedPeerInfo = {
        ipAddress: peerId.split(':')[0],
        wsPort: +peerId.split(':')[1],
      };

      if (this._peerBook.getPeer(bannedPeerInfo) && !isWhitelisted) {
        this._peerBook.removePeer(bannedPeerInfo);
      }
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_BAN_PEER, peerId);
    };

    this._handleUnbanPeer = (peerId) => {
      this._bannedPeers.delete(peerId.split(':')[0]);
      // Re-emit the message to allow it to bubble up the class hierarchy.
      this.emit(EVENT_UNBAN_PEER, peerId);
    };

    // When peer is fetched for status after connection then update the peerinfo in triedPeer list
    this._handleDiscoveredPeer = (detailedPeerInfo) => {
      const peerId = constructPeerIdFromPeerInfo(detailedPeerInfo);
      // Check blacklist to avoid incoming connections from backlisted ips
      const isBlacklisted = this._sanitizedPeerLists.blacklistedPeers.find(
        peer => constructPeerIdFromPeerInfo(peer) === peerId,
      );

      if (!this._peerBook.getPeer(detailedPeerInfo) && !isBlacklisted) {
        const foundPeer = this._peerBook.getPeer(detailedPeerInfo);

        if (foundPeer) {
          const updatedPeerInfo = {
            ...detailedPeerInfo,
            ipAddress: foundPeer.ipAddress,
            wsPort: foundPeer.wsPort,
          };
          const isUpdated = this._peerBook.updatePeer(updatedPeerInfo);
          if (isUpdated) {
            // If found and updated successfully then upgrade the peer
            this._peerBook.upgradePeer(updatedPeerInfo);
          }
        } else if (!detailedPeerInfo.isPassive) {
          this._peerBook.addPeer(detailedPeerInfo);
          // Re-emit the message to allow it to bubble up the class hierarchy.
          // Only emit event when a peer is discovered for the first time.
          this.emit(EVENT_DISCOVERED_PEER, detailedPeerInfo);
        }
      }
    };

    this._handleFailedToPushNodeInfo = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_TO_PUSH_NODE_INFO, error);
    };

    this._handleFailedToSendMessage = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_FAILED_TO_SEND_MESSAGE, error);
    };

    this._handleOutboundSocketError = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_OUTBOUND_SOCKET_ERROR, error);
    };

    this._handleInboundSocketError = (error) => {
      // Re-emit the error to allow it to bubble up the class hierarchy.
      this.emit(EVENT_INBOUND_SOCKET_ERROR, error);
    };

    this._peerPool = new PeerPool({
      connectTimeout: config.connectTimeout,
      ackTimeout: config.ackTimeout,
      wsMaxPayloadOutbound: config.wsMaxPayloadOutbound
        ? config.wsMaxPayloadOutbound
        : DEFAULT_WS_MAX_PAYLOAD_OUTBOUND,
      wsMaxPayloadInbound: config.wsMaxPayloadInbound
        ? config.wsMaxPayloadInbound
        : DEFAULT_WS_MAX_PAYLOAD_INBOUND,
      peerSelectionForSend: config.peerSelectionForSend
        ? config.peerSelectionForSend
        : selectPeersForSend,
      peerSelectionForRequest: config.peerSelectionForRequest
        ? config.peerSelectionForRequest
        : selectPeersForRequest,
      peerSelectionForConnection: config.peerSelectionForConnection
        ? config.peerSelectionForConnection
        : selectPeersForConnection,
      sendPeerLimit:
        config.sendPeerLimit === undefined
          ? DEFAULT_SEND_PEER_LIMIT
          : config.sendPeerLimit,
      peerBanTime: config.peerBanTime ? config.peerBanTime : DEFAULT_BAN_TIME,
      maxOutboundConnections:
        config.maxOutboundConnections === undefined
          ? DEFAULT_MAX_OUTBOUND_CONNECTIONS
          : config.maxOutboundConnections,
      maxInboundConnections:
        config.maxInboundConnections === undefined
          ? DEFAULT_MAX_INBOUND_CONNECTIONS
          : config.maxInboundConnections,
      maxPeerDiscoveryResponseLength:
        config.maxPeerDiscoveryResponseLength === undefined
          ? DEFAULT_MAX_PEER_DISCOVERY_RESPONSE_LENGTH
          : config.maxPeerDiscoveryResponseLength,
      maxPeerInfoSize: config.maxPeerInfoSize
        ? config.maxPeerInfoSize
        : DEFAULT_MAX_PEER_INFO_SIZE,
      outboundShuffleInterval: config.outboundShuffleInterval
        ? config.outboundShuffleInterval
        : DEFAULT_OUTBOUND_SHUFFLE_INTERVAL,
      netgroupProtectionRatio:
        typeof config.netgroupProtectionRatio === 'number'
          ? config.netgroupProtectionRatio
          : DEFAULT_PEER_PROTECTION_FOR_NETGROUP,
      latencyProtectionRatio:
        typeof config.latencyProtectionRatio === 'number'
          ? config.latencyProtectionRatio
          : DEFAULT_PEER_PROTECTION_FOR_LATENCY,
      productivityProtectionRatio:
        typeof config.productivityProtectionRatio === 'number'
          ? config.productivityProtectionRatio
          : DEFAULT_PEER_PROTECTION_FOR_USEFULNESS,
      longevityProtectionRatio:
        typeof config.longevityProtectionRatio === 'number'
          ? config.longevityProtectionRatio
          : DEFAULT_PEER_PROTECTION_FOR_LONGEVITY,
      wsMaxMessageRate:
        typeof config.wsMaxMessageRate === 'number'
          ? config.wsMaxMessageRate
          : DEFAULT_WS_MAX_MESSAGE_RATE,
      wsMaxMessageRatePenalty:
        typeof config.wsMaxMessageRatePenalty === 'number'
          ? config.wsMaxMessageRatePenalty
          : DEFAULT_WS_MAX_MESSAGE_RATE_PENALTY,
      rateCalculationInterval:
        typeof config.rateCalculationInterval === 'number'
          ? config.rateCalculationInterval
          : DEFAULT_RATE_CALCULATION_INTERVAL,
      secret: config.secret ? config.secret : DEFAULT_RANDOM_SECRET,
      peerLists: this._sanitizedPeerLists,
    });

    this._bindHandlersToPeerPool(this._peerPool);
    // Add peers to tried peers if want to re-use previously tried peers
    if (this._sanitizedPeerLists.previousPeers) {
      this._sanitizedPeerLists.previousPeers.forEach(peerInfo => {
        if (!peerInfo.isPassive) {
          if (!this._peerBook.getPeer(peerInfo)) {
            this._peerBook.addPeer(peerInfo);
            this._peerBook.upgradePeer(peerInfo);
          } else {
            this._peerBook.upgradePeer(peerInfo);
          }
        }
      });
    }

    this._nodeInfo = config.nodeInfo;
    this.applyNodeInfo(this._nodeInfo);

    this._populatorInterval = config.populatorInterval
      ? config.populatorInterval
      : DEFAULT_POPULATOR_INTERVAL;

    this._peerHandshakeCheck = config.peerHandshakeCheck
      ? config.peerHandshakeCheck
      : checkPeerCompatibility;
  }

  get config() {
    return this._config;
  }

  get isActive() {
    return this._isActive;
  }

  /**
   * This is not a declared as a setter because this method will need
   * invoke an async RPC on Peers to give them our new node status.
   */
  applyNodeInfo(nodeInfo) {
    this._nodeInfo = {
      ...nodeInfo,
    };
    this._peerPool.applyNodeInfo(this._nodeInfo);
  }

  get nodeInfo() {
    return this._nodeInfo;
  }

  applyPenalty(peerPenalty) {
    if (!this._isTrustedPeer(peerPenalty.peerId)) {
      this._peerPool.applyPenalty(peerPenalty);
    }
  }

  getConnectedPeers(kind) {
    return this._peerPool.getAllConnectedPeerInfos(kind);
  }

  getUniqueOutboundConnectedPeers() {
    return this._peerPool.getUniqueOutboundConnectedPeers();
  }

  getDisconnectedPeers() {
    const allPeers = this._peerBook.getAllPeers();
    const connectedPeers = this.getConnectedPeers();
    const connectedPeerIdSet = new Set(
      connectedPeers.map(peerInfo => constructPeerIdFromPeerInfo(peerInfo))
    );
    const disconnectedPeers = allPeers.filter(peerInfo => {
      const peerId = constructPeerIdFromPeerInfo(peerInfo);
      return !connectedPeerIdSet.has(peerId);
    });

    return disconnectedPeers;
  }

  async request(packet) {
    const response = await this._peerPool.request(packet);

    return response;
  }

  send(packet, peerLimit) {
    this._peerPool.send(packet, peerLimit);
  }

  async requestFromPeer(packet, peerId) {
    return this._peerPool.requestFromPeer(packet, peerId);
  }

  sendToPeer(message, peerId) {
    this._peerPool.sendToPeer(message, peerId);
  }

  _disconnectSocketDueToFailedHandshake(socket, statusCode, closeReason) {
    socket.disconnect(statusCode, closeReason);
    this.emit(
      EVENT_FAILED_TO_ADD_INBOUND_PEER,
      new PeerInboundHandshakeError(
        closeReason,
        statusCode,
        socket.remoteAddress,
        socket.request.url,
      )
    );
  }

  async _startPeerServer() {
    this._scServer.on(
      'connection',
      (socket) => {
        // Check blacklist to avoid incoming connections from backlisted ips
        if (this._sanitizedPeerLists.blacklistedPeers) {
          const blacklist = this._sanitizedPeerLists.blacklistedPeers.map(
            peer => peer.ipAddress,
          );
          if (blacklist.includes(socket.remoteAddress)) {
            this._disconnectSocketDueToFailedHandshake(
              socket,
              FORBIDDEN_CONNECTION,
              FORBIDDEN_CONNECTION_REASON,
            );

            return;
          }
        }

        if (!socket.request.url) {
          this._disconnectSocketDueToFailedHandshake(
            socket,
            INVALID_CONNECTION_URL_CODE,
            INVALID_CONNECTION_URL_REASON,
          );

          return;
        }

        const queryObject = url.parse(socket.request.url, true).query;

        if (queryObject.nonce === this._nodeInfo.nonce) {
          this._disconnectSocketDueToFailedHandshake(
            socket,
            INVALID_CONNECTION_SELF_CODE,
            INVALID_CONNECTION_SELF_REASON,
          );

          const selfWSPort = queryObject.wsPort
            ? +queryObject.wsPort
            : this._nodeInfo.wsPort;

          // Delete you peerinfo from both the lists
          this._peerBook.removePeer({
            ipAddress: socket.remoteAddress,
            wsPort: selfWSPort,
          });

          return;
        }

        if (
          (!queryObject.isPassive && typeof queryObject.wsPort !== 'string') ||
          typeof queryObject.version !== 'string' ||
          typeof queryObject.nethash !== 'string'
        ) {
          this._disconnectSocketDueToFailedHandshake(
            socket,
            INVALID_CONNECTION_QUERY_CODE,
            INVALID_CONNECTION_QUERY_REASON,
          );

          return;
        }

        let wsPort;
        if (queryObject.isPassive) {
          wsPort = socket.remotePort;
        } else {
          wsPort = parseInt(queryObject.wsPort, BASE_10_RADIX);
        }
        const peerId = constructPeerIdFromPeerInfo({
          ipAddress: socket.remoteAddress,
          wsPort,
        });

        // tslint:disable-next-line no-let
        let queryOptions;

        try {
          queryOptions =
            typeof queryObject.options === 'string'
              ? JSON.parse(queryObject.options)
              : undefined;
        } catch (error) {
          this._disconnectSocketDueToFailedHandshake(
            socket,
            INVALID_CONNECTION_QUERY_CODE,
            INVALID_CONNECTION_QUERY_REASON,
          );

          return;
        }

        if (this._bannedPeers.has(socket.remoteAddress)) {
          this._disconnectSocketDueToFailedHandshake(
            socket,
            FORBIDDEN_CONNECTION,
            FORBIDDEN_CONNECTION_REASON,
          );

          return;
        }

        const incomingPeerInfo = {
          ...queryObject,
          ...queryOptions,
          ipAddress: socket.remoteAddress,
          wsPort,
          height: queryObject.height ? +queryObject.height : 0,
          version: queryObject.version,
        };

        const { success, errors } = this._peerHandshakeCheck(
          incomingPeerInfo,
          this._nodeInfo,
        );

        if (!success) {
          const incompatibilityReason =
            errors && Array.isArray(errors)
              ? errors.join(',')
              : INCOMPATIBLE_PEER_UNKNOWN_REASON;

          this._disconnectSocketDueToFailedHandshake(
            socket,
            INCOMPATIBLE_PEER_CODE,
            incompatibilityReason,
          );

          return;
        }

        const existingPeer = this._peerPool.getPeer(peerId);

        if (existingPeer) {
          this._disconnectSocketDueToFailedHandshake(
            socket,
            DUPLICATE_CONNECTION,
            DUPLICATE_CONNECTION_REASON,
          );
        } else {
          this._peerPool.addInboundPeer(incomingPeerInfo, socket);
          this.emit(EVENT_NEW_INBOUND_PEER, incomingPeerInfo);
          this.emit(EVENT_NEW_PEER, incomingPeerInfo);
        }

        if (
          !incomingPeerInfo.isPassive &&
          !this._peerBook.getPeer(incomingPeerInfo)
        ) {
          this._peerBook.addPeer(incomingPeerInfo);
        }
      },
    );

    this._httpServer.listen(
      this._nodeInfo.wsPort,
      this._config.hostIp || DEFAULT_NODE_HOST_IP,
    );
    if (this._scServer.isReady) {
      this._isActive = true;

      return;
    }

    return new Promise(resolve => {
      this._scServer.once('ready', () => {
        this._isActive = true;
        resolve();
      });
    });
  }

  async _stopHTTPServer() {
    return new Promise(resolve => {
      this._httpServer.close(() => {
        resolve();
      });
    });
  }

  async _stopWSServer() {
    return new Promise(resolve => {
      this._scServer.close(() => {
        resolve();
      });
    });
  }

  async _stopPeerServer() {
    await this._stopWSServer();
    await this._stopHTTPServer();
  }

  _startPopulator() {
    if (this._populatorIntervalId) {
      throw new Error('Populator is already running');
    }
    this._populatorIntervalId = setInterval(() => {
      this._peerPool.triggerNewConnections(
        this._peerBook.newPeers,
        this._peerBook.triedPeers,
        this._sanitizedPeerLists.fixedPeers || [],
      );
    }, this._populatorInterval);
    this._peerPool.triggerNewConnections(
      this._peerBook.newPeers,
      this._peerBook.triedPeers,
      this._sanitizedPeerLists.fixedPeers || [],
    );
  }

  _stopPopulator() {
    if (this._populatorIntervalId) {
      clearInterval(this._populatorIntervalId);
    }
  }

  _isNetworkReady() {
    if (!this._hasConnected && this._peerPool.getConnectedPeers().length > 0) {
      this._hasConnected = true;

      return true;
    }

    return false;
  }

  _pickRandomPeers(count) {
    const peerList = this._peerBook.getAllPeers(); // Peers whose values has been updated at least once.

    return selectRandomPeerSample(peerList, count);
  }

  _handleGetPeersRequest(request) {
    const minimumPeerDiscoveryThreshold = this._config
      .minimumPeerDiscoveryThreshold
      ? this._config.minimumPeerDiscoveryThreshold
      : DEFAULT_MIN_PEER_DISCOVERY_THRESHOLD;
    const peerDiscoveryResponseLength = this._config.peerDiscoveryResponseLength
      ? this._config.peerDiscoveryResponseLength
      : DEFAULT_MAX_PEER_DISCOVERY_RESPONSE_LENGTH;

    const knownPeers = this._peerBook.getAllPeers();
    /* tslint:disable no-magic-numbers*/
    const min = Math.ceil(
      Math.min(peerDiscoveryResponseLength, knownPeers.length * 0.25),
    );
    const max = Math.floor(
      Math.min(peerDiscoveryResponseLength, knownPeers.length * 0.5),
    );
    const random = Math.floor(Math.random() * (max - min + 1) + min);
    const randomPeerCount = Math.max(
      random,
      Math.min(minimumPeerDiscoveryThreshold, knownPeers.length),
    );

    const selectedPeers = this._pickRandomPeers(randomPeerCount).map(
      outgoingPeerInfoSanitization, // Sanitize the peerInfos before responding to a peer that understand old peerInfo.
    );

    const peerInfoList = {
      success: true,
      peers: selectedPeers,
    };
    request.end(peerInfoList);
  }

  _isTrustedPeer(peerId) {
    const isSeed = this._sanitizedPeerLists.seedPeers.find(
      seedPeer =>
        peerId ===
        constructPeerIdFromPeerInfo({
          ipAddress: seedPeer.ipAddress,
          wsPort: seedPeer.wsPort,
        }),
    );

    const isWhitelisted = this._sanitizedPeerLists.whitelisted.find(
      peer => constructPeerIdFromPeerInfo(peer) === peerId,
    );

    const isFixed = this._sanitizedPeerLists.fixedPeers.find(
      peer => constructPeerIdFromPeerInfo(peer) === peerId,
    );

    return !!isSeed || !!isWhitelisted || !!isFixed;
  }

  async start() {
    if (this._isActive) {
      throw new Error('Cannot start the node because it is already active');
    }

    const newPeersToAdd = this._sanitizedPeerLists.seedPeers.concat(
      this._sanitizedPeerLists.whitelisted,
    );
    newPeersToAdd.forEach(newPeerInfo => {
      if (!newPeerInfo.isPassive && !this._peerBook.getPeer(newPeerInfo)) {
        this._peerBook.addPeer(newPeerInfo);
      }
    });

    // According to LIP, add whitelist peers to triedPeer by upgrading them initially.
    this._sanitizedPeerLists.whitelisted.forEach(whitelistPeer =>
      this._peerBook.upgradePeer(whitelistPeer),
    );
    await this._startPeerServer();

    // We need this check this._isActive in case the P2P library is shut down while it was in the middle of starting up.
    if (this._isActive) {
      this._startPopulator();
    }
  }

  async stop() {
    if (!this._isActive) {
      throw new Error('Cannot stop the node because it is not active');
    }
    this._isActive = false;
    this._hasConnected = false;
    this._stopPopulator();
    this._peerPool.removeAllPeers();
    await this._stopPeerServer();
  }

  _bindHandlersToPeerPool(peerPool) {
    peerPool.on(EVENT_REQUEST_RECEIVED, this._handlePeerPoolRPC);
    peerPool.on(EVENT_MESSAGE_RECEIVED, this._handlePeerPoolMessage);
    peerPool.on(EVENT_CONNECT_OUTBOUND, this._handleOutboundPeerConnect);
    peerPool.on(
      EVENT_CONNECT_ABORT_OUTBOUND,
      this._handleOutboundPeerConnectAbort,
    );
    peerPool.on(EVENT_CLOSE_INBOUND, this._handlePeerCloseInbound);
    peerPool.on(EVENT_CLOSE_OUTBOUND, this._handlePeerCloseOutbound);
    peerPool.on(EVENT_REMOVE_PEER, this._handleRemovePeer);
    peerPool.on(EVENT_UPDATED_PEER_INFO, this._handlePeerInfoUpdate);
    peerPool.on(
      EVENT_FAILED_PEER_INFO_UPDATE,
      this._handleFailedPeerInfoUpdate,
    );
    peerPool.on(
      EVENT_FAILED_TO_FETCH_PEER_INFO,
      this._handleFailedToFetchPeerInfo,
    );
    peerPool.on(EVENT_FAILED_TO_FETCH_PEERS, this._handleFailedToFetchPeers);
    peerPool.on(
      EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT,
      this._handleFailedToCollectPeerDetails,
    );
    peerPool.on(EVENT_DISCOVERED_PEER, this._handleDiscoveredPeer);
    peerPool.on(
      EVENT_FAILED_TO_PUSH_NODE_INFO,
      this._handleFailedToPushNodeInfo,
    );
    peerPool.on(EVENT_FAILED_TO_SEND_MESSAGE, this._handleFailedToSendMessage);
    peerPool.on(EVENT_OUTBOUND_SOCKET_ERROR, this._handleOutboundSocketError);
    peerPool.on(EVENT_INBOUND_SOCKET_ERROR, this._handleInboundSocketError);
    peerPool.on(EVENT_BAN_PEER, this._handleBanPeer);
    peerPool.on(EVENT_UNBAN_PEER, this._handleUnbanPeer);
  }
}

module.exports = {
  P2PRequest,
  EVENT_CLOSE_INBOUND,
  EVENT_CLOSE_OUTBOUND,
  EVENT_CONNECT_ABORT_OUTBOUND,
  EVENT_CONNECT_OUTBOUND,
  EVENT_DISCOVERED_PEER,
  EVENT_FAILED_TO_PUSH_NODE_INFO,
  EVENT_FAILED_TO_SEND_MESSAGE,
  EVENT_REMOVE_PEER,
  EVENT_REQUEST_RECEIVED,
  EVENT_MESSAGE_RECEIVED,
  EVENT_OUTBOUND_SOCKET_ERROR,
  EVENT_INBOUND_SOCKET_ERROR,
  EVENT_UPDATED_PEER_INFO,
  EVENT_FAILED_PEER_INFO_UPDATE,
  EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT,
  EVENT_FAILED_TO_FETCH_PEER_INFO,
  EVENT_BAN_PEER,
  EVENT_UNBAN_PEER,
  EVENT_NEW_INBOUND_PEER,
  EVENT_FAILED_TO_ADD_INBOUND_PEER,
  EVENT_NEW_PEER,
  EVENT_NETWORK_READY,
  DEFAULT_NODE_HOST_IP,
  DEFAULT_DISCOVERY_INTERVAL,
  DEFAULT_BAN_TIME,
  DEFAULT_POPULATOR_INTERVAL,
  DEFAULT_SEND_PEER_LIMIT,
  DEFAULT_WS_MAX_MESSAGE_RATE,
  DEFAULT_WS_MAX_MESSAGE_RATE_PENALTY,
  DEFAULT_RATE_CALCULATION_INTERVAL,
  DEFAULT_WS_MAX_PAYLOAD_OUTBOUND,
  DEFAULT_WS_MAX_PAYLOAD_INBOUND,
  DEFAULT_MAX_OUTBOUND_CONNECTIONS,
  DEFAULT_MAX_INBOUND_CONNECTIONS,
  DEFAULT_OUTBOUND_SHUFFLE_INTERVAL,
  DEFAULT_PEER_PROTECTION_FOR_NETGROUP,
  DEFAULT_PEER_PROTECTION_FOR_LATENCY,
  DEFAULT_PEER_PROTECTION_FOR_USEFULNESS,
  DEFAULT_PEER_PROTECTION_FOR_LONGEVITY,
  DEFAULT_MIN_PEER_DISCOVERY_THRESHOLD,
  DEFAULT_MAX_PEER_DISCOVERY_RESPONSE_LENGTH,
  DEFAULT_MAX_PEER_INFO_SIZE,
  DEFAULT_RANDOM_SECRET,
  P2P,
};
