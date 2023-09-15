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

 const { isIPv6 } = require('net');

const {
  ClientOptionsUpdated,
  DEFAULT_ACK_TIMEOUT,
  DEFAULT_CONNECT_TIMEOUT,
  EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT,
  Peer,
  PeerConfig,
  REMOTE_EVENT_MESSAGE,
  REMOTE_EVENT_RPC_REQUEST,
} = require('./base');

const { EVENT_PING } = require('./inbound');

const querystring = require('querystring');
const socketClusterClient = require('socketcluster-client');

const EVENT_DISCOVERED_PEER = 'discoveredPeer';
const EVENT_CONNECT_OUTBOUND = 'connectOutbound';
const EVENT_CONNECT_ABORT_OUTBOUND = 'connectAbortOutbound';
const EVENT_CLOSE_OUTBOUND = 'closeOutbound';
const EVENT_OUTBOUND_SOCKET_ERROR = 'outboundSocketError';
const RESPONSE_PONG = 'pong';
const PEER_KIND_OUTBOUND = 'outbound';

const socketErrorStatusCodes = {
  ...socketClusterClient.AGClientSocket.errorStatuses,
  1000: 'Intentionally disconnected',
};

class OutboundPeer extends Peer {
  constructor(peerInfo, peerConfig) {
    super(peerInfo, peerConfig);
    this.kind = PEER_KIND_OUTBOUND;
  }

  send(packet) {
    if (!this._socket) {
      this._socket = this._createOutboundSocket();
    }

    super.send(packet);
  }

  async request(packet) {
    if (!this._socket) {
      this._socket = this._createOutboundSocket();
    }

    return super.request(packet);
  }

  _createOutboundSocket() {
    const nodeInfo = this._nodeInfo ? this._nodeInfo : undefined;

    const connectTimeout = this._peerConfig.connectTimeout
      ? this._peerConfig.connectTimeout
      : DEFAULT_CONNECT_TIMEOUT;
    const ackTimeout = this._peerConfig.ackTimeout
      ? this._peerConfig.ackTimeout
      : DEFAULT_ACK_TIMEOUT;

    // Ideally, we should JSON-serialize the whole NodeInfo object but this cannot be done for compatibility reasons, so instead we put it inside an options property.
    const clientOptions = {
      hostname: isIPv6(this._ipAddress) ? `[${this._ipAddress}]` : this._ipAddress,
      port: this._wsPort,
      query: querystring.stringify({
        ...nodeInfo,
      }),
      connectTimeout,
      ackTimeout,
      autoConnect: false,
      autoReconnect: false,
      wsOptions: {
        maxPayload: this._peerConfig.wsMaxPayloadOutbound,
      },
    };

    const outboundSocket = socketClusterClient.create(clientOptions);
    this._bindHandlersToOutboundSocket(outboundSocket);

    return outboundSocket;
  }

  connect() {
    if (!this._socket) {
      this._socket = this._createOutboundSocket();
    }
    this._socket.connect();
  }

  disconnect(code = 1000, reason) {
    super.disconnect(code, reason);

    if (this._socket) {
      this._unbindHandlersFromOutboundSocket(this._socket);
    }
  }

  async _bindEventHandlerToSocket(socket, eventName, handler) {
    for await (let event of socket.listener(eventName)) {
      handler(event);
    }
  }

  // All event handlers for the outbound socket should be bound in this method.
  _bindHandlersToOutboundSocket(outboundSocket) {
    this._bindEventHandlerToSocket(outboundSocket, 'error', ({error}) => {
      this.emit(EVENT_OUTBOUND_SOCKET_ERROR, error);
    });

    this._bindEventHandlerToSocket(outboundSocket, 'connect', async () => {
      this.emit(EVENT_CONNECT_OUTBOUND, this._peerInfo);
      try {
        await Promise.all([this.fetchStatus(), this.discoverPeers()]);
      } catch (error) {
        this.emit(EVENT_FAILED_TO_COLLECT_PEER_DETAILS_ON_CONNECT, error);
      }
    });

    this._bindEventHandlerToSocket(outboundSocket, 'connectAbort', () => {
      this.emit(EVENT_CONNECT_ABORT_OUTBOUND, this._peerInfo);
    });

    this._bindEventHandlerToSocket(outboundSocket, 'close', ({code, reason}) => {
      const sanitizedReason = reason
        ? reason
        : socketErrorStatusCodes[code] || 'Unknown reason';

      this.emit(EVENT_CLOSE_OUTBOUND, {
        peerInfo: this._peerInfo,
        code,
        reason: sanitizedReason,
      });
    });

    this._bindEventHandlerToSocket(outboundSocket, 'message', this._handleWSMessage);

    (async () => {
      for await (let request of outboundSocket.procedure(EVENT_PING)) {
        request.end(RESPONSE_PONG);
      }
    })();

    // Bind RPC and remote message handlers
    (async () => {
      for await (let request of outboundSocket.procedure(REMOTE_EVENT_RPC_REQUEST)) {
        this._handleRawRPC(request);
      }
    })();

    (async () => {
      for await (let data of outboundSocket.receiver(REMOTE_EVENT_MESSAGE)) {
        this._handleRawMessage(data);
      }
    })();
  }

  // All event handlers for the outbound socket should be unbound in this method.
  _unbindHandlersFromOutboundSocket(outboundSocket) {
    // Close appends a packet to the end of the stream which will close all of
    // its consumers.
    outboundSocket.closeListener('error');
    outboundSocket.closeListener('connect');
    outboundSocket.closeListener('connectAbort');
    outboundSocket.closeListener('close');

    // Streams which can be influenced by the peer need to be stopped immediately
    // with kill instead of close.
    outboundSocket.killListener('message');

    outboundSocket.killProcedure(EVENT_PING);
    outboundSocket.killProcedure(REMOTE_EVENT_RPC_REQUEST);

    outboundSocket.killReceiver(REMOTE_EVENT_MESSAGE);
  }
}

module.exports = {
  EVENT_DISCOVERED_PEER,
  EVENT_CONNECT_OUTBOUND,
  EVENT_CONNECT_ABORT_OUTBOUND,
  EVENT_CLOSE_OUTBOUND,
  EVENT_OUTBOUND_SOCKET_ERROR,
  RESPONSE_PONG,
  PEER_KIND_OUTBOUND,
  OutboundPeer,
};
