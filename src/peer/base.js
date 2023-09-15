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

const { EventEmitter } = require('events');
const {
  FORBIDDEN_CONNECTION,
  FORBIDDEN_CONNECTION_REASON,
  FAILED_TO_RESPOND,
  FAILED_TO_RESPOND_REASON,
} = require('../disconnect_status_codes');
const { RPCResponseError, RPCTimeoutError } = require('../errors');
const { P2PRequest } = require('../p2p_request');
const { getPeerIdFromPeerInfo } = require('../utils');

const {
  validatePeerInfo,
  validatePeersInfoList,
  validateProtocolMessage,
  validateRPCRequest,
} = require('../validation');

// Local emitted events.
const EVENT_REQUEST_RECEIVED = 'requestReceived';
const EVENT_INVALID_REQUEST_RECEIVED = 'invalidRequestReceived';
const EVENT_MESSAGE_RECEIVED = 'messageReceived';
const EVENT_INVALID_MESSAGE_RECEIVED = 'invalidMessageReceived';
const EVENT_BAN_PEER = 'banPeer';
const EVENT_DISCOVERED_PEER = 'discoveredPeer';
const EVENT_UNBAN_PEER = 'unbanPeer';
const EVENT_UPDATED_PEER_INFO = 'updatedPeerInfo';
const EVENT_FAILED_PEER_INFO_UPDATE = 'failedPeerInfoUpdate';
const EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT =
  'failedToCollectPeerDetailsOnConnect';
const EVENT_FAILED_TO_FETCH_PEERS = 'failedToFetchPeers';
const EVENT_FAILED_TO_FETCH_PEER_INFO = 'failedToFetchPeerInfo';
const EVENT_FAILED_TO_PUSH_NODE_INFO = 'failedToPushNodeInfo';

// Remote event or RPC names sent to or received from peers.
const REMOTE_EVENT_RPC_REQUEST = 'rpc-request';
const REMOTE_EVENT_MESSAGE = 'remote-message';

const REMOTE_RPC_UPDATE_PEER_INFO = 'updateMyself';
const REMOTE_RPC_GET_NODE_INFO = 'status';
const REMOTE_RPC_GET_PEERS_LIST = 'list';

const REMOTE_MESSAGE_NODE_INFO_CHANGED = 'nodeInfoChanged';

const DEFAULT_CONNECT_TIMEOUT = 2000;
const DEFAULT_ACK_TIMEOUT = 2000;
const DEFAULT_REPUTATION_SCORE = 100;
const DEFAULT_PRODUCTIVITY_RESET_INTERVAL = 20000;
const DEFAULT_PRODUCTIVITY = {
  requestCounter: 0,
  responseCounter: 0,
  responseRate: 0,
  lastResponded: 0,
};

// Can be used to convert a rate which is based on the rateCalculationInterval into a per-second rate.
const RATE_NORMALIZATION_FACTOR = 1000;

const ConnectionState = {
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSED: 'closed',
};

class Peer extends EventEmitter {
  constructor(peerInfo, peerConfig) {
    super();
    this._peerInfo = peerInfo;
    this._peerConfig = peerConfig;
    this._ipAddress = peerInfo.ipAddress;
    this._wsPort = peerInfo.wsPort;
    this._id = getPeerIdFromPeerInfo({
      ipAddress: this._ipAddress,
      wsPort: this._wsPort,
    });
    this._active = true;
    this._height = peerInfo.height ? peerInfo.height : 0;
    this._reputation = DEFAULT_REPUTATION_SCORE;
    this._latency = 0;
    this._connectTime = Date.now();
    this._rpcCounter = new Map();
    this._rpcRates = new Map();
    this._messageCounter = new Map();
    this._messageRates = new Map();
    this._wsMessageCount = 0;
    this._wsMessageRate = 0;
    this._rateInterval = this._peerConfig.rateCalculationInterval;

    this._counterResetInterval = setInterval(() => {
      this._wsMessageRate =
        (this._wsMessageCount * RATE_NORMALIZATION_FACTOR) / this._rateInterval;
      this._wsMessageCount = 0;

      if (this._wsMessageRate > this._peerConfig.wsMaxMessageRate) {
        this.applyPenalty(this._peerConfig.wsMaxMessageRatePenalty);

        return;
      }

      this._rpcRates = new Map(
        [...this._rpcCounter.entries()].map(([key, value]) => {
          const rate = value / this._rateInterval;

          return [key, rate];
        }),
      );
      this._rpcCounter = new Map();

      this._messageRates = new Map(
        [...this._messageCounter.entries()].map(([key, value]) => {
          const rate = value / this._rateInterval;

          return [key, rate];
        }),
      );
      this._messageCounter = new Map();
    }, this._rateInterval);

    this._productivityResetInterval = setInterval(() => {
      // If peer has not recently responded, reset productivity to 0
      if (
        this._productivity.lastResponded <
        Date.now() - DEFAULT_PRODUCTIVITY_RESET_INTERVAL
      ) {
        this._productivity = { ...DEFAULT_PRODUCTIVITY };
      }
    }, DEFAULT_PRODUCTIVITY_RESET_INTERVAL);
    this._productivity = { ...DEFAULT_PRODUCTIVITY };

    // This needs to be an arrow function so that it can be used as a listener.
    this._handleRawRPC = (scRequest) => {
      let packet = scRequest.data;

      let rawRequest;
      try {
        rawRequest = validateRPCRequest(packet);
      } catch (err) {
        scRequest.error(err);
        this.emit(EVENT_INVALID_REQUEST_RECEIVED, {
          packet,
          peerId: this._id,
        });

        return;
      }

      this._updateRPCCounter(rawRequest);
      const rate = this._getRPCRate(rawRequest);

      const request = new P2PRequest(
        {
          procedure: rawRequest.procedure,
          data: rawRequest.data,
          id: this._id,
          rate,
          productivity: this._productivity,
        },
        scRequest,
      );

      if (rawRequest.procedure === REMOTE_RPC_UPDATE_PEER_INFO) {
        this._handleUpdatePeerInfo(request);
      } else if (rawRequest.procedure === REMOTE_RPC_GET_NODE_INFO) {
        this._handleGetNodeInfo(request);
      }

      this.emit(EVENT_REQUEST_RECEIVED, request);
    };

    this._handleWSMessage = () => {
      this._wsMessageCount += 1;
    };

    // This needs to be an arrow function so that it can be used as a listener.
    this._handleRawMessage = (packet) => {
      // tslint:disable-next-line:no-let
      let message;
      try {
        message = validateProtocolMessage(packet);
      } catch (err) {
        this.emit(EVENT_INVALID_MESSAGE_RECEIVED, {
          packet,
          peerId: this._id,
        });

        return;
      }

      this._updateMessageCounter(message);
      const rate = this._getMessageRate(message);
      const messageWithRateInfo = {
        ...message,
        peerId: this._id,
        rate,
      };

      this.emit(EVENT_MESSAGE_RECEIVED, messageWithRateInfo);
    };
  }

  get height() {
    return this._height;
  }

  get id() {
    return this._id;
  }

  get ipAddress() {
    return this._ipAddress;
  }

  get reputation() {
    return this._reputation;
  }

  get latency() {
    return this._latency;
  }

  get connectTime() {
    return this._connectTime;
  }

  get responseRate() {
    return this._productivity.responseRate;
  }

  get productivity() {
    return { ...this._productivity };
  }

  get wsMessageRate() {
    return this._wsMessageRate;
  }

  updatePeerInfo(newPeerInfo) {
    // The ipAddress and wsPort properties cannot be updated after the initial discovery.
    this._peerInfo = {
      ...newPeerInfo,
      ipAddress: this._ipAddress,
      wsPort: this._wsPort,
    };
  }

  get peerInfo() {
    return this._peerInfo;
  }

  applyPenalty(penalty) {
    this._reputation -= penalty;
    if (this._reputation <= 0) {
      this._banPeer();
    }
  }

  get wsPort() {
    return this._wsPort;
  }

  get state() {
    const state = this._socket
      ? this._socket.state === this._socket.OPEN
        ? ConnectionState.OPEN
        : ConnectionState.CLOSED
      : ConnectionState.CLOSED;

    return state;
  }

  /**
   * This is not a declared as a setter because this method will need
   * invoke an async RPC on the socket to pass it the new node status.
   */
  async applyNodeInfo(nodeInfo) {
    this._nodeInfo = nodeInfo;
    if (this._peerInfo.isPassive) {
      if (!this._socket) {
        throw new Error('Passive peer socket does not exist');
      }
      this._socket.transmit(REMOTE_MESSAGE_NODE_INFO_CHANGED, this._nodeInfo);
    } else {
      await this.request({
        procedure: REMOTE_RPC_UPDATE_PEER_INFO,
        data: this._nodeInfo,
      });
    }
  }

  get nodeInfo() {
    return this._nodeInfo;
  }

  connect() {
    if (!this._socket) {
      throw new Error('Peer socket does not exist');
    }
  }

  disconnect(code = 1000, reason) {
    if (this._active) {
      this._active = false;
      clearInterval(this._counterResetInterval);
      clearInterval(this._productivityResetInterval);
      if (this._socket) {
        this._socket.disconnect(code, reason);
      }
    }
  }

  send(packet) {
    if (!this._socket) {
      throw new Error('Peer socket does not exist');
    }
    this._socket.transmit(REMOTE_EVENT_MESSAGE, {
      event: packet.event,
      data: packet.data,
    });
  }

  async request(packet) {
    this._productivity.requestCounter += 1;
    let socket = this._socket;
    if (!socket) {
      throw new Error('Peer socket does not exist');
    }
    let responseData;
    try {
      responseData = await socket.invoke(REMOTE_EVENT_RPC_REQUEST, {
        type: '/RPCRequest',
        procedure: packet.procedure,
        data: packet.data,
      });
    } catch (err) {
      if (err.name === 'TimeoutError') {

        this.disconnect(FAILED_TO_RESPOND, FAILED_TO_RESPOND_REASON);

        throw new RPCTimeoutError(
          err.message,
          `${this.ipAddress}:${this.wsPort}`,
        );
      } else {
        throw new RPCResponseError(
          err.message,
          `${this.ipAddress}:${this.wsPort}`,
        );
      }

      return;
    }

    if (responseData) {
      this._productivity.lastResponded = Date.now();
      this._productivity.responseCounter += 1;
      this._productivity.responseRate =
        this._productivity.responseCounter /
        this._productivity.requestCounter;

      return responseData;
    }

    throw new RPCResponseError(
      `Failed to handle response for procedure ${packet.procedure}`,
      `${this.ipAddress}:${this.wsPort}`,
    );
  }

  async fetchPeers() {
    try {
      const response = await this.request({
        procedure: REMOTE_RPC_GET_PEERS_LIST,
      });
      return validatePeersInfoList(
        response.data,
        this._peerConfig.maxPeerDiscoveryResponseLength,
        this._peerConfig.maxPeerInfoSize,
      );
    } catch (error) {
      this.emit(EVENT_FAILED_TO_FETCH_PEERS, error);

      throw new RPCResponseError(
        'Failed to fetch peer list of peer',
        this.ipAddress,
      );
    }
  }

  async discoverPeers() {
    const discoveredPeerInfoList = await this.fetchPeers();
    discoveredPeerInfoList.forEach(peerInfo => {
      this.emit(EVENT_DISCOVERED_PEER, peerInfo);
    });

    return discoveredPeerInfoList;
  }

  async fetchStatus() {
    // tslint:disable-next-line:no-let
    let response;
    try {
      response = await this.request({
        procedure: REMOTE_RPC_GET_NODE_INFO,
      });
    } catch (error) {
      this.emit(EVENT_FAILED_TO_FETCH_PEER_INFO, error);

      throw new RPCResponseError(
        'Failed to fetch peer info of peer',
        `${this.ipAddress}:${this.wsPort}`,
      );
    }
    try {
      this._updateFromProtocolPeerInfo(response.data);
    } catch (error) {
      this.emit(EVENT_FAILED_PEER_INFO_UPDATE, error);

      throw new RPCResponseError(
        'Failed to update peer info of peer as part of fetch operation',
        `${this.ipAddress}:${this.wsPort}`,
      );
    }

    this.emit(EVENT_UPDATED_PEER_INFO, this._peerInfo);

    // Return the updated detailed peer info.
    return this._peerInfo;
  }

  _updateFromProtocolPeerInfo(rawPeerInfo) {
    const protocolPeerInfo = { ...rawPeerInfo, ip: this._ipAddress };
    const newPeerInfo = validatePeerInfo(
      protocolPeerInfo,
      this._peerConfig.maxPeerInfoSize,
    );
    this.updatePeerInfo(newPeerInfo);
  }

  _handleUpdatePeerInfo(request) {
    // Update peerInfo with the latest values from the remote peer.
    try {
      this._updateFromProtocolPeerInfo(request.data);
    } catch (error) {
      this.emit(EVENT_FAILED_PEER_INFO_UPDATE, error);
      request.error(error);

      return;
    }
    request.end();
    this.emit(EVENT_UPDATED_PEER_INFO, this._peerInfo);
  }

  _handleGetNodeInfo(request) {
    const nodeInfo = this._nodeInfo
      ? this._nodeInfo
      : {};
    request.end(nodeInfo);
  }

  _banPeer() {
    this.emit(EVENT_BAN_PEER, this._id);
    this.disconnect(FORBIDDEN_CONNECTION, FORBIDDEN_CONNECTION_REASON);
  }

  _updateRPCCounter(packet) {
    const key = packet.procedure;
    const count = (this._rpcCounter.get(key) || 0) + 1;
    this._rpcCounter.set(key, count);
  }

  _getRPCRate(packet) {
    const rate = this._rpcRates.get(packet.procedure) || 0;

    return rate * RATE_NORMALIZATION_FACTOR;
  }

  _updateMessageCounter(packet) {
    const key = packet.event;
    const count = (this._messageCounter.get(key) || 0) + 1;
    this._messageCounter.set(key, count);
  }

  _getMessageRate(packet) {
    const rate = this._messageRates.get(packet.event) || 0;

    return rate * RATE_NORMALIZATION_FACTOR;
  }
}

module.exports = {
  EVENT_REQUEST_RECEIVED,
  EVENT_INVALID_REQUEST_RECEIVED,
  EVENT_MESSAGE_RECEIVED,
  EVENT_INVALID_MESSAGE_RECEIVED,
  EVENT_BAN_PEER,
  EVENT_DISCOVERED_PEER,
  EVENT_UNBAN_PEER,
  EVENT_UPDATED_PEER_INFO,
  EVENT_FAILED_PEER_INFO_UPDATE,
  EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT,
  EVENT_FAILED_TO_FETCH_PEERS,
  EVENT_FAILED_TO_FETCH_PEER_INFO,
  EVENT_FAILED_TO_PUSH_NODE_INFO,
  REMOTE_EVENT_RPC_REQUEST,
  REMOTE_EVENT_MESSAGE,
  REMOTE_RPC_UPDATE_PEER_INFO,
  REMOTE_RPC_GET_NODE_INFO,
  REMOTE_RPC_GET_PEERS_LIST,
  DEFAULT_CONNECT_TIMEOUT,
  DEFAULT_ACK_TIMEOUT,
  DEFAULT_REPUTATION_SCORE,
  DEFAULT_PRODUCTIVITY_RESET_INTERVAL,
  DEFAULT_PRODUCTIVITY,
  ConnectionState,
  Peer,
};
