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
const {
  Peer,
  PeerConfig,
  REMOTE_EVENT_MESSAGE,
  REMOTE_EVENT_RPC_REQUEST,
} = require('./base');

const { AGServerSocket } = require('socketcluster-server');
const socketErrorStatusCodes = {
  ...AGServerSocket.errorStatuses,
  1000: 'Intentionally disconnected',
};

const EVENT_CLOSE_INBOUND = 'closeInbound';
const EVENT_INBOUND_SOCKET_ERROR = 'inboundSocketError';
const EVENT_PING = 'ping';

const DEFAULT_PING_INTERVAL_MAX = 60000;
const DEFAULT_PING_INTERVAL_MIN = 20000;
const PEER_KIND_INBOUND = 'inbound';

function getRandomPingDelay() {
  return Math.round(
    Math.random() *
      (DEFAULT_PING_INTERVAL_MAX - DEFAULT_PING_INTERVAL_MIN) +
      DEFAULT_PING_INTERVAL_MIN
  );
}

class InboundPeer extends Peer {
  constructor(peerInfo, peerSocket, peerConfig) {
    super(peerInfo, peerConfig);
    this.kind = PEER_KIND_INBOUND;
    this._handleInboundSocketError = ({error}) => {
      this.emit(EVENT_INBOUND_SOCKET_ERROR, error);
    };
    this._handleInboundSocketClose = ({code, reason}) => {
      const sanitizedReason = reason
        ? reason
        : socketErrorStatusCodes[code] || 'Unknown reason';
      if (this._pingTimeoutId) {
        clearTimeout(this._pingTimeoutId);
      }
      this.emit(EVENT_CLOSE_INBOUND, {
        peerInfo,
        code,
        reason: sanitizedReason,
      });
    };
    this._sendPing = async () => {
      const pingStart = Date.now();
      try {
        await this._socket.invoke(EVENT_PING);
      } catch (error) {}
      this._latency = Date.now() - pingStart;
      this._pingTimeoutId = setTimeout(this._sendPing, getRandomPingDelay());
    };
    this._pingTimeoutId = setTimeout(this._sendPing, getRandomPingDelay());
    this._socket = peerSocket;
    this._bindHandlersToInboundSocket(this._socket);
  }

  disconnect(code = 1000, reason) {
    super.disconnect(code, reason);
    this._unbindHandlersFromInboundSocket(this._socket);
  }

  async _bindEventHandlerToSocket(socket, eventName, handler) {
    for await (let event of socket.listener(eventName)) {
      handler(event);
    }
  }

  // All event handlers for the inbound socket should be bound in this method.
  _bindHandlersToInboundSocket(inboundSocket) {
    this._bindEventHandlerToSocket(inboundSocket, 'error', this._handleInboundSocketError);
    this._bindEventHandlerToSocket(inboundSocket, 'close', this._handleInboundSocketClose);
    this._bindEventHandlerToSocket(inboundSocket, 'message', this._handleWSMessage);

    // Bind RPC and remote message handlers
    (async () => {
      for await (let request of inboundSocket.procedure(REMOTE_EVENT_RPC_REQUEST)) {
        this._handleRawRPC(request);
      }
    })();

    (async () => {
      for await (let data of inboundSocket.receiver(REMOTE_EVENT_MESSAGE)) {
        this._handleRawMessage(data);
      }
    })();
  }

  // All event handlers for the inbound socket should be unbound in this method.
  _unbindHandlersFromInboundSocket(inboundSocket) {
    // Close appends a packet to the end of the stream which will close all of
    // its consumers.
    inboundSocket.closeListener('error');
    inboundSocket.closeListener('close');

    // Streams which can be influenced by the peer need to be stopped immediately
    // with kill instead of close.
    inboundSocket.killListener('message');

    inboundSocket.killProcedure(REMOTE_EVENT_RPC_REQUEST);

    inboundSocket.killReceiver(REMOTE_EVENT_MESSAGE);
  }
}

module.exports = {
  EVENT_CLOSE_INBOUND,
  EVENT_INBOUND_SOCKET_ERROR,
  EVENT_PING,
  PEER_KIND_INBOUND,
  InboundPeer,
};
